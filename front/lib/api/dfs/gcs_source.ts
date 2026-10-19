import type { Readable } from "node:stream";
import type {
  GcsReplicationMetadata,
  GcsReplicationSource,
} from "@app/lib/api/dfs/gcs_notifications";
import { GcsReplicationMetadataSchema } from "@app/lib/api/dfs/gcs_notifications";
import fileStorageConfig from "@app/lib/file_storage/config";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { GoogleAuth } from "google-auth-library";
import { request } from "undici";
import { fromError } from "zod-validation-error";

const REQUEST_TIMEOUT_MS = 60_000;
let googleAuth: GoogleAuth | undefined;

type GcsSourceRead =
  | { status: "absent" }
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
  source: Pick<GcsReplicationSource, "bucket" | "objectName">,
  {
    versions,
    accessToken,
    signal,
  }: {
    versions?: Pick<GcsReplicationMetadata, "generation" | "metageneration">;
    accessToken: string;
    signal?: AbortSignal;
  }
) {
  const url = new URL(
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(source.bucket)}/o/${encodeURIComponent(source.objectName)}`
  );
  if (versions) {
    url.searchParams.set("alt", "media");
    url.searchParams.set("ifGenerationMatch", versions.generation);
    url.searchParams.set("ifMetagenerationMatch", versions.metageneration);
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
export async function readGcsReplicationSource(
  source: Pick<GcsReplicationSource, "bucket" | "objectName">,
  { signal }: { signal?: AbortSignal } = {}
): Promise<Result<GcsSourceRead, Error>> {
  if (signal?.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const token = await getAccessToken();
  if (token.isErr()) {
    return token;
  }

  const live = await getObject(source, { accessToken: token.value, signal });
  if (live.isErr()) {
    return live;
  }
  if (live.value.statusCode !== 200) {
    live.value.body.destroy();
    return live.value.statusCode === 404
      ? new Ok({ status: "absent" })
      : new Err(
          new Error(`GCS metadata read failed (${live.value.statusCode}).`)
        );
  }
  let payload: unknown;
  try {
    payload = await live.value.body.json();
  } catch (error) {
    return new Err(normalizeError(error));
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

  const response = await getObject(source, {
    versions: metadata,
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
  return new Err(new Error(`GCS content read failed (${statusCode}).`));
}
