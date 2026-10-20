import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import {
  GcsReplicationMetadataSchema,
  parseGcsReplicationPath,
} from "@app/lib/api/dfs/gcs_notifications";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { formatDfsUri } from "@app/lib/dfs/uri";
import type { DfsObjectId, DfsOperation } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { z } from "zod";
import { fromError } from "zod-validation-error";

export const GCS_SYNC_XATTR = "front.gcs_sync";
// GCS content is copied without decompression.
export const GCS_CONTENT_ENCODING_XATTR = "front.gcs_content_encoding";

const GcsSyncSchema = GcsReplicationMetadataSchema.pick({
  bucket: true,
  generation: true,
  metageneration: true,
}).extend({ objectName: z.string().min(1) });

function readSyncMarker(
  value: Uint8Array | undefined
): Result<z.infer<typeof GcsSyncSchema> | null, Error> {
  if (value === undefined) {
    return new Ok(null);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(value).toString("utf8"));
  } catch (error) {
    return new Err(normalizeError(error));
  }
  const parsed = GcsSyncSchema.safeParse(payload);
  return parsed.success
    ? new Ok(parsed.data)
    : new Err(fromError(parsed.error));
}

/**
 * Copy the live GCS source into an existing, mapped DFS file, or delete that file when the
 * source is absent. Destination creation, grants, source mapping and leases belong to the caller.
 * This is not yet bound to the Temporal activity: DFS does not support fenced writes.
 */
/**
 * @cc [owner:flvndvd,label:security;concurrency] gcs-import-prepared-target
 * The caller MUST resolve the target and client in the source workspace, establish its initial
 * grants, and verify that GCS still owns its content. It MUST hold the source lease from before
 * this call through completion, using a client whose mutations DFS fences against that lease.
 * Cancellation checks here MUST NOT be treated as fencing. The target IDs MUST come from the
 * durable source mapping, never from an unverified path lookup. Missing live targets MUST fail;
 * this function MUST NOT create a replacement with a different ID or change grants.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-import-completion
 * Generation and metageneration MUST remain strings. A complete marker for the same source and
 * generation MAY reuse bytes; a missing marker MUST force a full rewrite. The marker MUST be
 * removed in a checked request before mutations and set only after a successful full transfer
 * with the expected size, or reuse of complete bytes. Setting attributes and the marker MUST
 * use one Update operation after checking all preceding results, since Apply can partly succeed.
 * A failed or ambiguous completion request MUST NOT trigger cleanup that could erase a committed
 * marker. Other xattrs MUST remain unchanged. A marker for another source MUST fail closed.
 */
export async function importGcsSourceToDfsFile(
  source: GcsReplicationSource,
  {
    client,
    target,
    signal,
  }: {
    client: DfsFileSystemClient;
    target: { objectId: DfsObjectId; parentId: DfsObjectId };
    signal: AbortSignal;
  }
): Promise<Result<void, Error>> {
  const pathRes = parseGcsReplicationPath(source.objectName);
  if (pathRes.isErr()) {
    return pathRes;
  }
  if (pathRes.value?.workspaceId !== source.workspaceId) {
    return new Err(new Error("Invalid GCS replication source workspace."));
  }
  if (signal.aborted) {
    return new Err(normalizeError(signal.reason));
  }

  // DfsClient does not yet accept AbortSignal. Check between requests, including every chunk.
  // An already admitted request can still commit; the server must enforce the lease.
  const apply: DfsFileSystemClient["apply"] = async (request) => {
    if (signal.aborted) {
      return new Err(new DfsError("unavailable", "GCS import canceled."));
    }
    const appliedRes = await client.apply(request);
    return signal.aborted
      ? new Err(new DfsError("unavailable", "GCS import canceled."))
      : appliedRes;
  };
  const applyOne = async (
    operation: DfsOperation
  ): Promise<Result<void, Error>> => {
    const appliedRes = await apply({ operations: [operation] });
    if (appliedRes.isErr()) {
      return appliedRes;
    }
    const [result] = appliedRes.value.results;
    return result.status === "error"
      ? new Err(new DfsError(result.errorCode))
      : new Ok(undefined);
  };

  const statRes = await client.stat({
    objectIds: [target.objectId],
    includeMetadata: true,
  });
  if (statRes.isErr()) {
    return statRes;
  }
  const [stat] = statRes.value.results;
  if (stat.status === "error" && stat.errorCode !== "not_found") {
    return new Err(new DfsError(stat.errorCode));
  }
  const existing = stat.status === "ok" ? stat.object : null;
  if (existing && (existing.kind !== "file" || !existing.metadata)) {
    return new Err(
      new DfsError("invalid_response", "Expected a file with metadata.")
    );
  }
  const markerRes = readSyncMarker(existing?.metadata?.xattrs[GCS_SYNC_XATTR]);
  if (markerRes.isErr()) {
    return markerRes;
  }
  const marker = markerRes.value;
  if (
    marker &&
    (marker.bucket !== source.bucket || marker.objectName !== source.objectName)
  ) {
    return new Err(new Error("DFS file belongs to another GCS source."));
  }

  const sourceRes = await readGcsReplicationSource(source, { signal });
  if (sourceRes.isErr()) {
    return sourceRes;
  }
  if (signal.aborted) {
    if (sourceRes.value.status === "live") {
      sourceRes.value.stream.destroy();
    }
    return new Err(normalizeError(signal.reason));
  }
  if (sourceRes.value.status === "absent") {
    return existing
      ? applyOne({ type: "remove", ...target, kind: "file" })
      : new Ok(undefined);
  }

  const { stream, metadata } = sourceRes.value;
  // A stream can fail while DFS requests are pending, before write starts consuming it.
  const ignoreUntilConsumed = () => {};
  stream.on("error", ignoreUntilConsumed);
  try {
    if (!existing) {
      return new Err(
        new DfsError("not_found", "The mapped DFS file is missing.")
      );
    }
    const size = Number(metadata.size);
    if (!Number.isSafeInteger(size)) {
      return new Err(
        new Error("GCS object size exceeds the DFS client's integer range.")
      );
    }
    const reuseContent =
      marker?.generation === metadata.generation && existing.size === size;
    if (reuseContent && marker.metageneration === metadata.metageneration) {
      return new Ok(undefined);
    }

    const clearedRes = await applyOne({
      type: "update",
      objectId: target.objectId,
      xattrs: [{ name: GCS_SYNC_XATTR }],
    });
    if (clearedRes.isErr()) {
      return clearedRes;
    }
    if (!reuseContent) {
      const fs = new DfsFileSystem({
        apply,
        stat: (request) => client.stat(request),
        lookup: (request) => client.lookup(request),
        list: (request) => client.list(request),
        read: (request) => client.read(request),
      });
      const writtenRes = await fs.write(formatDfsUri(target.objectId), stream);
      if (writtenRes.isErr()) {
        return writtenRes;
      }
      if (writtenRes.value.attr.size !== size) {
        return new Err(
          new Error("GCS content length does not match its metadata.")
        );
      }
    }

    return await applyOne({
      type: "update",
      objectId: target.objectId,
      mimeType: metadata.contentType ?? "",
      mtimeMs: metadata.updated ? Date.parse(metadata.updated) : undefined,
      xattrs: [
        {
          name: GCS_CONTENT_ENCODING_XATTR,
          value: metadata.contentEncoding
            ? Buffer.from(metadata.contentEncoding, "utf8")
            : undefined,
        },
        {
          name: GCS_SYNC_XATTR,
          value: Buffer.from(
            JSON.stringify({
              bucket: source.bucket,
              objectName: source.objectName,
              generation: metadata.generation,
              metageneration: metadata.metageneration,
            })
          ),
        },
      ],
    });
  } finally {
    // Unchanged and metadata-only imports do not consume the opened media stream.
    stream.destroy();
  }
}
