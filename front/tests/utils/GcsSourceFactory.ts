import type { GcsReplicationMetadata } from "@app/lib/api/dfs/gcs_source";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";

export class GcsSourceFactory {
  static metadata(
    overrides: Partial<GcsReplicationMetadata> = {}
  ): GcsReplicationMetadata {
    const source = GcsNotificationFactory.replicationSource();

    return {
      bucket: source.bucket,
      name: source.objectName,
      generation: "9007199254740993",
      metageneration: "1",
      size: "3",
      contentType: "text/plain",
      ...overrides,
    };
  }
}
