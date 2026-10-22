import type { Readable } from "node:stream";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import type { GcsReplicationMetadata } from "@app/lib/api/dfs/gcs_source";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { newDfsObjectId } from "@app/lib/dfs/object_id";
import { formatDfsUri } from "@app/lib/dfs/uri";
import type { DfsAttr, DfsObjectId, DfsOperation } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { z } from "zod";

export const GCS_SOURCE_XATTR = "front.gcs_source";
export const GCS_SYNC_XATTR = "front.gcs_sync";
export const GCS_CONTENT_ENCODING_XATTR = "front.gcs_content_encoding";

const GcsSyncSchema = z.object({
  bucket: z.string(),
  objectName: z.string(),
  generation: z.string(),
  metageneration: z.string(),
  contentVersion: z.string(),
});

/**
 * @cc [owner:flvndvd,label:security] gcs-import-resolved-target
 * The caller MUST authorize the source and destination in the same workspace and pass a
 * conditional GCS read for that source. Existing files MUST belong to the same GCS source.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-import-stream-lifetime
 * The caller owns the stream and MUST destroy it when the import returns or fails.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-import-completion
 * Clear the completion marker before modifying content or metadata. Set it only after the full
 * copy succeeds. Reuse bytes only when the source generation and DFS content version match.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-import-activation
 * GCS must remain authoritative, with exclusive access to the source and destination during the
 * call. This helper MUST NOT be registered as the Temporal importer until DFS mutations support
 * fencing. It does not reconcile deletions or track files moved away from their imported path.
 */
export async function importGcsFile(
  source: GcsReplicationSource,
  {
    client,
    folderId,
    path,
    metadata,
    stream,
    signal,
  }: {
    client: DfsFileSystemClient;
    folderId: DfsObjectId;
    path: string[];
    metadata: GcsReplicationMetadata;
    stream: Readable;
    signal?: AbortSignal;
  }
): Promise<Result<DfsObjectId, Error>> {
  const fs = new DfsFileSystem(client);
  const fileRes = await getOrCreateSourceFile(
    fs,
    client,
    folderId,
    path,
    source
  );
  if (fileRes.isErr()) {
    return fileRes;
  }

  const file = fileRes.value;
  const synced = readSyncMarker(file);
  const reuseContent =
    synced?.bucket === source.bucket &&
    synced.objectName === source.objectName &&
    synced.generation === metadata.generation &&
    synced.contentVersion === file.contentVersion.toString() &&
    BigInt(file.size) === BigInt(metadata.size);

  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  if (reuseContent && synced.metageneration === metadata.metageneration) {
    return new Ok(file.id);
  }

  const clearedRes = await applyToFile(client, {
    type: "update",
    objectId: file.id,
    xattrs: [{ name: GCS_SYNC_XATTR }],
  });
  if (clearedRes.isErr()) {
    return clearedRes;
  }

  let contentVersion = file.contentVersion;
  if (!reuseContent) {
    const writtenRes = await fs.write(formatDfsUri(file.id), stream);
    if (writtenRes.isErr()) {
      return writtenRes;
    }
    contentVersion = writtenRes.value.attr.contentVersion;
  }

  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const completedRes = await applyToFile(client, {
    type: "update",
    objectId: file.id,
    mimeType: metadata.contentType ?? "application/octet-stream",
    mtimeMs: metadata.updated ? Date.parse(metadata.updated) : undefined,
    xattrs: [
      {
        name: GCS_CONTENT_ENCODING_XATTR,
        value: metadata.contentEncoding
          ? Buffer.from(metadata.contentEncoding)
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
            contentVersion: contentVersion.toString(),
          })
        ),
      },
    ],
  });
  if (completedRes.isErr()) {
    return completedRes;
  }

  return signal?.aborted
    ? new Err(normalizeError(signal.reason))
    : new Ok(file.id);
}

async function getOrCreateSourceFile(
  fs: DfsFileSystem,
  client: DfsFileSystemClient,
  folderId: DfsObjectId,
  path: string[],
  source: GcsReplicationSource
): Promise<Result<DfsAttr, Error>> {
  const uri = formatDfsUri(folderId, { path });
  const existingRes = await fs.stat(uri, { includeMetadata: true });
  if (existingRes.isErr()) {
    return existingRes;
  }

  const identity = Buffer.from(
    JSON.stringify({
      bucket: source.bucket,
      objectName: source.objectName,
    })
  );
  if (existingRes.value) {
    const file = existingRes.value.attr;
    const stored = file.metadata?.xattrs[GCS_SOURCE_XATTR];
    if (file.kind !== "file" || !stored || !identity.equals(stored)) {
      return new Err(
        new Error("DFS destination already belongs to another source.")
      );
    }
    return new Ok(file);
  }

  let parentId = folderId;
  if (path.length > 1) {
    const parentUri = formatDfsUri(folderId, { path: path.slice(0, -1) });
    const madeRes = await fs.mkdir(parentUri);
    if (madeRes.isErr() && madeRes.error.code !== "already_exists") {
      return madeRes;
    }
    const parentRes = await fs.stat(parentUri);
    if (parentRes.isErr()) {
      return parentRes;
    }
    if (!parentRes.value || parentRes.value.attr.kind !== "directory") {
      return new Err(new Error("DFS destination parent is not a directory."));
    }
    parentId = parentRes.value.attr.id;
  }

  return applyToFile(client, {
    type: "create",
    parentId,
    name: path[path.length - 1],
    objectId: newDfsObjectId(),
    kind: "file",
    xattrs: { [GCS_SOURCE_XATTR]: identity },
  });
}

async function applyToFile(
  client: DfsFileSystemClient,
  operation: DfsOperation
): Promise<Result<DfsAttr, Error>> {
  const appliedRes = await client.apply({ operations: [operation] });
  if (appliedRes.isErr()) {
    return appliedRes;
  }

  const result = appliedRes.value.results[0];
  if (result?.status === "error") {
    return new Err(new DfsError(result.errorCode));
  }
  return result?.mutation.object
    ? new Ok(result.mutation.object)
    : new Err(
        new DfsError("invalid_response", "DFS returned no file attributes.")
      );
}

function readSyncMarker(file: DfsAttr): z.infer<typeof GcsSyncSchema> | null {
  const marker = file.metadata?.xattrs[GCS_SYNC_XATTR];
  if (!marker) {
    return null;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(marker).toString("utf8"));
  } catch {
    return null;
  }
  const parsedRes = GcsSyncSchema.safeParse(payload);
  return parsedRes.success ? parsedRes.data : null;
}
