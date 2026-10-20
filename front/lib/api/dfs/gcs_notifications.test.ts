import { parseGcsReplicationNotification } from "@app/lib/api/dfs/gcs_notifications";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { describe, expect, it } from "vitest";

const source = GcsNotificationFactory.source;

describe("parseGcsReplicationNotification", () => {
  it("preserves literal object names", () => {
    const message = GcsNotificationFactory.message({
      metadata: {
        name: "w/workspace/conversations/conversation/files/dir/100%2F #é.txt",
      },
    });
    const result = parseGcsReplicationNotification(message, source);

    expect(result.isOk() && result.value).toEqual({
      workspaceId: "workspace",
      bucket: source.bucket,
      objectName:
        "w/workspace/conversations/conversation/files/dir/100%2F #é.txt",
    });
  });

  it.each([
    "OBJECT_FINALIZE",
    "OBJECT_METADATA_UPDATE",
    "OBJECT_DELETE",
    "OBJECT_ARCHIVE",
  ])("extracts the same source identifiers for %s", (eventType) => {
    const result = parseGcsReplicationNotification(
      GcsNotificationFactory.message({ eventType }),
      source
    );

    expect(result.isOk() && result.value).toEqual(
      GcsNotificationFactory.replicationSource()
    );
  });

  it.each([
    "files/w/workspace/original.txt",
    "w/workspace/pods/pod/sandbox-functions/bundle.tar",
    "w/workspace/pods/pod/state/db",
    "w/workspace/pods/pod/files/dir/",
  ])("ignores objects outside the file scope: %s", (name) => {
    const result = parseGcsReplicationNotification(
      GcsNotificationFactory.message({ metadata: { name } }),
      source
    );

    expect(result.isOk() && result.value).toBeNull();
  });

  it.each([
    "w/workspace/pods/pod/files/../secret",
    "w/workspace/pods/pod/files/./report.txt",
    "w/workspace/pods/pod/files/a//b",
    "w//pods/pod/files/report.txt",
    "w/workspace/pods/pod/files/report\0.txt",
  ])("rejects paths that cannot map to a distinct DFS file: %s", (name) => {
    expect(
      parseGcsReplicationNotification(
        GcsNotificationFactory.message({ metadata: { name } }),
        source
      ).isErr()
    ).toBe(true);
  });

  it.each([
    { bucket: "another-bucket" },
    { notificationConfig: "another-notification" },
  ])("rejects an unexpected notification source: %o", (override) => {
    expect(
      parseGcsReplicationNotification(GcsNotificationFactory.message(), {
        ...source,
        ...override,
      }).isErr()
    ).toBe(true);
  });

  it.each([
    { bucket: "another-bucket" },
    { name: "w/another-workspace/pods/pod/files/report.txt" },
    { generation: "9007199254740992" },
    { generation: 9007199254740992 },
    { generation: undefined },
  ])("rejects inconsistent or incomplete payloads: %o", (override) => {
    const message = GcsNotificationFactory.message();

    expect(
      parseGcsReplicationNotification(
        {
          ...message,
          data: Buffer.from(
            JSON.stringify({
              ...JSON.parse(message.data.toString()),
              ...override,
            })
          ),
        },
        source
      ).isErr()
    ).toBe(true);
  });

  it("rejects malformed JSON", () => {
    expect(
      parseGcsReplicationNotification(
        { ...GcsNotificationFactory.message(), data: Buffer.from("{") },
        source
      ).isErr()
    ).toBe(true);
  });

  it("excludes object metadata from the workflow source", () => {
    const message = GcsNotificationFactory.message();
    const result = parseGcsReplicationNotification(
      {
        ...message,
        data: Buffer.from(
          JSON.stringify({
            ...JSON.parse(message.data.toString()),
            metageneration: "9007199254740994",
            contentType: "text/plain",
            metadata: { grants: "allow everyone" },
          })
        ),
      },
      source
    );

    expect(result.isOk() && result.value).toEqual(
      GcsNotificationFactory.replicationSource()
    );
  });
});
