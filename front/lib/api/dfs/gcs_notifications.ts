import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { z } from "zod";
import { fromError } from "zod-validation-error";

const GcsVersionSchema = z.string().regex(/^[1-9][0-9]*$/);

const NotificationPayloadSchema = z.object({
  bucket: z.string().min(1),
  name: z.string().min(1),
  generation: GcsVersionSchema,
});

const NotificationAttributesSchema = z.object({
  notificationConfig: z.string().min(1),
  eventType: z.enum([
    "OBJECT_FINALIZE",
    "OBJECT_METADATA_UPDATE",
    "OBJECT_DELETE",
    "OBJECT_ARCHIVE",
  ]),
  payloadFormat: z.literal("JSON_API_V1"),
  bucketId: z.string().min(1),
  objectId: z.string().min(1),
  objectGeneration: GcsVersionSchema,
});

interface GcsReplicationPath {
  workspaceId: string;
  kind: "pod" | "conversation";
  resourceId: string;
  path: string[];
}

export interface GcsReplicationSource {
  workspaceId: string;
  bucket: string;
  objectName: string;
}

/**
 * @cc [owner:flvndvd,label:security] gcs-notification-source
 * Accepted events MUST match the configured bucket and notification identity. Payload bucket,
 * name and generation MUST match the attributes. Only source identifiers MUST be returned.
 */
export function parseGcsReplicationNotification(
  message: { attributes: unknown; data: Buffer },
  source: { bucket: string; notificationConfig: string }
): Result<GcsReplicationSource | null, Error> {
  const attributesRes = NotificationAttributesSchema.safeParse(
    message.attributes
  );
  if (!attributesRes.success) {
    return new Err(fromError(attributesRes.error));
  }

  const { bucketId, notificationConfig, objectId, objectGeneration } =
    attributesRes.data;

  if (
    bucketId !== source.bucket ||
    notificationConfig !== source.notificationConfig
  ) {
    return new Err(new Error("Unexpected GCS notification source."));
  }

  const pathRes = parseGcsReplicationPath(objectId);
  if (pathRes.isErr()) {
    return pathRes;
  }

  if (!pathRes.value) {
    return new Ok(null);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(message.data.toString("utf8"));
  } catch (error) {
    return new Err(normalizeError(error));
  }

  const payloadRes = NotificationPayloadSchema.safeParse(payload);
  if (!payloadRes.success) {
    return new Err(fromError(payloadRes.error));
  }

  if (
    payloadRes.data.bucket !== bucketId ||
    payloadRes.data.name !== objectId ||
    payloadRes.data.generation !== objectGeneration
  ) {
    return new Err(
      new Error("GCS notification attributes and payload differ.")
    );
  }

  return new Ok({
    workspaceId: pathRes.value.workspaceId,
    bucket: bucketId,
    objectName: objectId,
  });
}

/**
 * @cc [owner:flvndvd,label:security] gcs-notification-path
 * Only conversation and pod `files/` objects are eligible. Names MUST NOT be URL-decoded or
 * normalized. Empty, dot and parent components MUST fail rather than alias another DFS path.
 * Directory marker objects (names ending in `/`) and objects outside these prefixes are ignored.
 */
export function parseGcsReplicationPath(
  objectName: string
): Result<GcsReplicationPath | null, Error> {
  const [root, workspaceId, namespace, resourceId, folder, ...path] =
    objectName.split("/");

  if (
    root !== "w" ||
    (namespace !== "pods" && namespace !== "conversations") ||
    folder !== "files" ||
    objectName.endsWith("/")
  ) {
    return new Ok(null);
  }

  if (
    path.length === 0 ||
    [workspaceId, resourceId, ...path].some(
      (part) => !part || part === "." || part === ".." || part.includes("\0")
    )
  ) {
    return new Err(new Error("Invalid GCS replication path."));
  }

  return new Ok({
    workspaceId,
    kind: namespace === "pods" ? "pod" : "conversation",
    resourceId,
    path,
  });
}
