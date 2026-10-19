import type { Readable } from "node:stream";
import type {
  GcsReplicationMetadata,
  GcsReplicationNotification,
} from "@app/lib/api/dfs/gcs_notifications";
import { GcsReplicationMetadataSchema } from "@app/lib/api/dfs/gcs_notifications";
import fileStorageConfig from "@app/lib/file_storage/config";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { GoogleAuth } from "google-auth-library";
import { request } from "undici";
import { fromError } from "zod-validation-error";

const REQUEST_TIMEOUT_MS = 60_000;
let googleAuth: GoogleAuth | undefined;

type GcsSourceRead =
  | { status: "absent" }
  | { status: "superseded" }
  | {
      status: "live";
      metadata: GcsReplicationMetadata;
      stream: Readable;
    };

async function getAccessToken(): Promise<Result<string, Error>> {
  googleAuth ??= new GoogleAuth({
    keyFilename: fileStorageConfig.getServiceAccount(),
    scopes: ["https://www.googleapis.com/auth/devstorage.read_only"],
  });
  try {
    const token = await googleAuth.getAccessToken();
    return token
      ? new Ok(token)
      : new Err(new Error("GCP auth returned no access token."));
  } catch (error) {
    return new Err(normalizeError(error));
  }
}

async function getObject(
  metadata: GcsReplicationMetadata,
  {
    media,
    accessToken,
    signal,
  }: { media: boolean; accessToken: string; signal?: AbortSignal }
) {
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(metadata.bucket)}/o/${encodeURIComponent(metadata.name)}`
  );
  if (media) {
    url.searchParams.set("alt", "media");
    url.searchParams.set("ifGenerationMatch", metadata.generation);
    url.searchParams.set("ifMetagenerationMatch", metadata.metageneration);
  }
  // Do not set `generation`: it selects a retained revision instead of checking the live object.
  try {
    return new Ok(
      await request(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${accessToken}`,
          // Match gcsfuse's stored bytes. undici.request does not decompress the response.
          "accept-encoding": "gzip",
        },
        headersTimeout: REQUEST_TIMEOUT_MS,
        bodyTimeout: REQUEST_TIMEOUT_MS,
        signal,
      })
    );
  } catch (error) {
    return new Err(normalizeError(error));
  }
}

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-replication-live-read
 * Finalize and metadata events MUST read with both event versions as preconditions. Delete and
 * archive events MUST first read live metadata. Only a live-object 404 may return `absent`.
 * A change between a delete/archive metadata read and its media read MUST remain retryable.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-replication-read-lock
 * The caller MUST hold the source lock from before this read through the DFS commit. A `live`
 * result only opens the transfer: the caller MUST consume or destroy its stream, and MUST NOT
 * acknowledge or mark an import complete unless the entire stream and all DFS writes succeed.
 */
export async function readGcsReplicationSource(
  notification: GcsReplicationNotification,
  { signal }: { signal?: AbortSignal } = {}
): Promise<Result<GcsSourceRead, Error>> {
  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const token = await getAccessToken();
  if (token.isErr()) {
    return token;
  }

  let metadata = notification.metadata;
  let reconcileCurrent: boolean;
  switch (notification.eventType) {
    case "OBJECT_FINALIZE":
    case "OBJECT_METADATA_UPDATE":
      reconcileCurrent = false;
      break;
    case "OBJECT_DELETE":
    case "OBJECT_ARCHIVE":
      reconcileCurrent = true;
      break;
    default:
      return assertNever(notification.eventType);
  }

  if (reconcileCurrent) {
    const response = await getObject(metadata, {
      media: false,
      accessToken: token.value,
      signal,
    });
    if (response.isErr()) {
      return response;
    }
    const { statusCode, body } = response.value;
    if (statusCode !== 200) {
      body.destroy();
      return statusCode === 404
        ? new Ok({ status: "absent" })
        : new Err(new Error(`GCS metadata read failed (${statusCode}).`));
    }
    let payload: unknown;
    try {
      payload = await body.json();
    } catch (error) {
      return new Err(normalizeError(error));
    }
    const parsed = GcsReplicationMetadataSchema.safeParse(payload);
    if (!parsed.success) {
      return new Err(fromError(parsed.error));
    }
    if (
      parsed.data.bucket !== metadata.bucket ||
      parsed.data.name !== metadata.name
    ) {
      return new Err(new Error("GCS returned metadata for another object."));
    }
    metadata = parsed.data;
  }

  const response = await getObject(metadata, {
    media: true,
    accessToken: token.value,
    signal,
  });
  if (response.isErr()) {
    return response;
  }
  const { statusCode, body } = response.value;
  if (statusCode === 200) {
    return new Ok({ status: "live", metadata, stream: body });
  }
  body.destroy();
  if (!reconcileCurrent) {
    if (statusCode === 412) {
      return new Ok({ status: "superseded" });
    }
    if (statusCode === 404) {
      return new Ok({ status: "absent" });
    }
  }
  return new Err(new Error(`GCS content read failed (${statusCode}).`));
}
