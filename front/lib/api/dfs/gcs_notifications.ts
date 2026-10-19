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

export interface GcsReplicationNotification {
  eventType: z.infer<typeof NotificationAttributesSchema>["eventType"];
  metadata: GcsReplicationMetadata;
  destination: {
    workspaceId: string;
    kind: "pod" | "conversation";
    resourceId: string;
    path: string[];
  };
}

/**
 * @cc [owner:flvndvd,label:security] gcs-notification-source
 * Accepted events MUST match the configured bucket and notification identity. Payload bucket,
 * name and generation MUST match the attributes. Custom metadata MUST NOT supply DFS grants.
 */
/**
 * @cc [owner:flvndvd,label:security] gcs-notification-path
 * Only conversation and pod `files/` objects are eligible. Names MUST NOT be URL-decoded or
 * normalized. Empty, dot and parent components MUST fail rather than alias another DFS path.
 * Directory marker objects (names ending in `/`) and objects outside these prefixes are ignored.
 */
export function parseGcsReplicationNotification(
  message: { attributes: unknown; data: Buffer },
  source: { bucket: string; notificationConfig: string }
): Result<GcsReplicationNotification | null, Error> {
  const attributes = NotificationAttributesSchema.safeParse(message.attributes);
  if (!attributes.success) {
    return new Err(fromError(attributes.error));
  }
  const {
    bucketId,
    notificationConfig,
    objectId,
    objectGeneration,
    eventType,
  } = attributes.data;
  if (
    bucketId !== source.bucket ||
    notificationConfig !== source.notificationConfig
  ) {
    return new Err(new Error("Unexpected GCS notification source."));
  }

  const [root, workspaceId, namespace, resourceId, folder, ...path] =
    objectId.split("/");
  if (
    root !== "w" ||
    (namespace !== "pods" && namespace !== "conversations") ||
    folder !== "files" ||
    objectId.endsWith("/")
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

  let payload: unknown;
  try {
    payload = JSON.parse(message.data.toString("utf8"));
  } catch (error) {
    return new Err(normalizeError(error));
  }
  const metadata = GcsReplicationMetadataSchema.safeParse(payload);
  if (!metadata.success) {
    return new Err(fromError(metadata.error));
  }
  if (
    metadata.data.bucket !== bucketId ||
    metadata.data.name !== objectId ||
    metadata.data.generation !== objectGeneration
  ) {
    return new Err(
      new Error("GCS notification attributes and payload differ.")
    );
  }

  return new Ok({
    eventType,
    metadata: metadata.data,
    destination: {
      workspaceId,
      kind: namespace === "pods" ? "pod" : "conversation",
      resourceId,
      path,
    },
  });
}
