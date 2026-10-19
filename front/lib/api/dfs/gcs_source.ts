import { once } from "node:events";
import { addAbortSignal, Readable } from "node:stream";
import type {
  GcsReplicationMetadata,
  GcsReplicationSource,
} from "@app/lib/api/dfs/gcs_notifications";
import { GcsReplicationMetadataSchema } from "@app/lib/api/dfs/gcs_notifications";
import { getBucketInstance } from "@app/lib/file_storage";
import { isGCSNotFoundError } from "@app/lib/file_storage/types";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { fromError } from "zod-validation-error";

const REQUEST_TIMEOUT_MS = 60_000;

type GcsSourceRead =
  | { status: "absent" }
  | {
      status: "live";
      metadata: GcsReplicationMetadata;
      stream: Readable;
    };

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-replication-live-read
 * Every pass MUST read current metadata, then condition its content read on both returned
 * versions. Only a live metadata 404 may return `absent`. A 404 or 412 on the subsequent content
 * read MUST remain retryable. Notification versions MUST NOT select the version to import.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-replication-read-lock
 * The caller MUST hold the source lock from before this read through the DFS commit. A `live`
 * result only opens the transfer: the caller MUST consume or destroy its stream, and MUST NOT
 * mark an import complete unless the entire stream and all DFS writes succeed.
 */
/**
 * @cc [owner:flvndvd,label:product] gcs-replication-stored-bytes
 * The returned stream MUST preserve the bytes stored in GCS, including gzip compression.
 * Content MUST NOT be decompressed during transfer to DFS.
 */
export async function readGcsReplicationSource(
  source: Pick<GcsReplicationSource, "bucket" | "objectName">,
  { signal }: { signal?: AbortSignal } = {}
): Promise<Result<GcsSourceRead, Error>> {
  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const file = getBucketInstance(source.bucket, {
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    // Temporal retries the whole read from current metadata.
    autoRetry: false,
  }).file(source.objectName);
  let payload: unknown;
  try {
    [payload] = await file.getMetadata();
  } catch (error) {
    if (signal?.aborted) {
      return new Err(normalizeError(signal.reason));
    }
    return isGCSNotFoundError(error)
      ? new Ok({ status: "absent" })
      : new Err(normalizeError(error));
  }
  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const parsed = GcsReplicationMetadataSchema.safeParse(payload);
  if (!parsed.success) {
    return new Err(fromError(parsed.error));
  }
  const metadata = parsed.data;
  if (
    metadata.bucket !== source.bucket ||
    metadata.name !== source.objectName
  ) {
    return new Err(new Error("GCS returned metadata for another object."));
  }

  // createReadStream does not expose both preconditions. Use the same file client's
  // authenticated request stream, relative to the object, without selecting a retained generation.
  const stream = file.requestStream({
    uri: "",
    qs: {
      alt: "media",
      ifGenerationMatch: metadata.generation,
      ifMetagenerationMatch: metadata.metageneration,
    },
    headers: { "accept-encoding": "gzip" },
    gzip: false,
  });
  if (signal) {
    addAbortSignal(signal, stream);
  }
  try {
    const [response] = await once(stream, "response");
    if (response.statusCode !== 200) {
      stream.destroy();
      return new Err(
        new Error(`GCS content read failed (${response.statusCode}).`)
      );
    }
    const contentStream = new Readable({
      destroy: (error, callback) => {
        stream.destroy(error ?? undefined);
        callback(error);
      },
    }).wrap(stream);
    return new Ok({ status: "live", metadata, stream: contentStream });
  } catch (error) {
    stream.destroy();
    return new Err(normalizeError(error));
  }
}
