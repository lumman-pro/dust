import type {
  GcsReplicationMetadata,
  GcsReplicationNotification,
} from "@app/lib/api/dfs/gcs_notifications";

export class GcsNotificationFactory {
  static readonly source = {
    bucket: "test-private-bucket",
    notificationConfig:
      "projects/_/buckets/test-private-bucket/notificationConfigs/1",
  };

  static notification({
    eventType = "OBJECT_FINALIZE",
    metadata = {},
    workspaceId = "workspace",
  }: {
    eventType?: GcsReplicationNotification["eventType"];
    metadata?: Partial<GcsReplicationMetadata>;
    workspaceId?: string;
  } = {}): GcsReplicationNotification {
    return {
      eventType,
      metadata: {
        bucket: this.source.bucket,
        name: `w/${workspaceId}/pods/pod/files/report.txt`,
        generation: "9007199254740993",
        metageneration: "1",
        size: "3",
        contentType: "text/plain",
        ...metadata,
      },
      destination: {
        workspaceId,
        kind: "pod",
        resourceId: "pod",
        path: ["report.txt"],
      },
    };
  }

  static message(options: Parameters<typeof this.notification>[0] = {}) {
    const { eventType, metadata } = this.notification(options);
    return {
      attributes: {
        notificationConfig: this.source.notificationConfig,
        eventType,
        payloadFormat: "JSON_API_V1",
        bucketId: metadata.bucket,
        objectId: metadata.name,
        objectGeneration: metadata.generation,
      },
      data: Buffer.from(JSON.stringify(metadata)),
    };
  }
}
