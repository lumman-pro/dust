import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";

export class GcsNotificationFactory {
  static readonly source = {
    bucket: "test-private-bucket",
    notificationConfig:
      "projects/_/buckets/test-private-bucket/notificationConfigs/1",
  };

  static message({
    eventType = "OBJECT_FINALIZE",
    metadata = {},
    workspaceId = "workspace",
  }: {
    eventType?: string;
    metadata?: Partial<{ bucket: string; name: string; generation: string }>;
    workspaceId?: string;
  } = {}) {
    const payload = {
      bucket: this.source.bucket,
      name: `w/${workspaceId}/pods/pod/files/report.txt`,
      generation: "9007199254740993",
      ...metadata,
    };

    return {
      attributes: {
        notificationConfig: this.source.notificationConfig,
        eventType,
        payloadFormat: "JSON_API_V1",
        bucketId: payload.bucket,
        objectId: payload.name,
        objectGeneration: payload.generation,
      },
      data: Buffer.from(JSON.stringify(payload)),
    };
  }

  static replicationSource(
    overrides: Partial<GcsReplicationSource> = {}
  ): GcsReplicationSource {
    return {
      workspaceId: "workspace",
      bucket: this.source.bucket,
      objectName: "w/workspace/pods/pod/files/report.txt",
      ...overrides,
    };
  }
}
