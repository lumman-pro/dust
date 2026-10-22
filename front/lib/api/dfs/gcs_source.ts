import { once } from "node:events";
import { addAbortSignal, pipeline, Readable, Transform } from "node:stream";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { getBucketInstance } from "@app/lib/file_storage";
import { isGCSNotFoundError } from "@app/lib/file_storage/types";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { z } from "zod";
import { fromError } from "zod-validation-error";

const GcsVersionSchema = z.string().regex(/^[1-9][0-9]*$/);

export const GcsReplicationMetadataSchema = z.object({
  bucket: z.string().min(1),
  name: z.string().min(1),
  generation: GcsVersionSchema,
  metageneration: GcsVersionSchema,
  size: z.string().regex(/^(0|[1-9][0-9]*)$/),
  contentType: z.string().optional(),
  contentEncoding: z.string().optional(),
  crc32c: z.string().optional(),
  updated: z.string().datetime({ offset: true }).optional(),
});

export type GcsReplicationMetadata = z.infer<
  typeof GcsReplicationMetadataSchema
>;

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
 * @cc [owner:flvndvd,label:concurrency] gcs-replication-stream-lifetime
 * The caller MUST consume or destroy a returned stream. Newly copied bytes MUST NOT be marked
 * complete unless the entire stream and all DFS writes succeed.
 */
/**
 * @cc [owner:flvndvd,label:product] gcs-replication-stored-bytes
 * The returned stream MUST preserve the bytes stored in GCS, including gzip compression.
 * Content MUST NOT be decompressed during transfer to DFS.
 */
/**
 * @cc [owner:flvndvd,label:error-handling] gcs-replication-transfer-integrity
 * A fully consumed stream MUST fail if its byte count differs from metadata.size or its CRC32C
 * differs from metadata.crc32c when provided. These failures MUST be emitted as stream errors,
 * since the read returns before the transfer finishes. Destroying the stream without consuming
 * it MUST cancel the HTTP transfer and MUST NOT imply successful validation.
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

  const parsedRes = GcsReplicationMetadataSchema.safeParse(payload);
  if (!parsedRes.success) {
    return new Err(fromError(parsedRes.error));
  }

  const metadata = parsedRes.data;
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
    headers: { "accept-encoding": "gzip", "cache-control": "no-store" },
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

    const crc32c = file.crc32cGenerator();
    let receivedBytes = BigInt(0);
    const verifiedStream = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        receivedBytes += BigInt(chunk.length);
        crc32c.update(chunk);
        callback(null, chunk);
      },
      flush: (callback) => {
        if (receivedBytes !== BigInt(metadata.size)) {
          callback(
            new Error("GCS content length does not match its metadata.")
          );
        } else if (
          metadata.crc32c !== undefined &&
          crc32c.toString() !== metadata.crc32c
        ) {
          callback(
            new Error("GCS content CRC32C does not match its metadata.")
          );
        } else {
          callback();
        }
      },
    });

    // pipeline forwards errors and destroys the HTTP stream if the consumer stops early.
    pipeline(contentStream, verifiedStream, () => {});
    return new Ok({ status: "live", metadata, stream: verifiedStream });
  } catch (error) {
    stream.destroy();
    return new Err(normalizeError(error));
  }
}
