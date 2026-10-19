import { parseGcsReplicationNotification } from "@app/lib/api/dfs/gcs_notifications";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { describe, expect, it } from "vitest";

const source = GcsNotificationFactory.source;

describe("parseGcsReplicationNotification", () => {
  it("keeps generations lossless and preserves literal object names", () => {
    const message = GcsNotificationFactory.message({
      metadata: {
        name: "w/workspace/conversations/conversation/files/dir/100%2F #é.txt",
        metageneration: "9007199254740994",
      },
    });
    const result = parseGcsReplicationNotification(message, source);

    expect(result.isOk() && result.value).toMatchObject({
      metadata: {
        generation: "9007199254740993",
        metageneration: "9007199254740994",
      },
      destination: {
        workspaceId: "workspace",
        kind: "conversation",
        resourceId: "conversation",
        path: ["dir", "100%2F #é.txt"],
      },
    });
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
    { metageneration: 1 },
    { metageneration: undefined },
  ])("rejects inconsistent or incomplete payloads: %o", (override) => {
    const message = GcsNotificationFactory.message();
    const metadata = GcsNotificationFactory.notification().metadata;
    expect(
      parseGcsReplicationNotification(
        {
          ...message,
          data: Buffer.from(JSON.stringify({ ...metadata, ...override })),
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

  it("takes metageneration from the payload rather than a custom attribute", () => {
    const message = GcsNotificationFactory.message();
    const result = parseGcsReplicationNotification(
      {
        ...message,
        attributes: { ...message.attributes, metageneration: "99" },
      },
      source
    );
    expect(result.isOk() && result.value?.metadata.metageneration).toBe("1");
  });

  it("does not retain custom metadata as DFS attributes or grants", () => {
    const message = GcsNotificationFactory.message();
    const result = parseGcsReplicationNotification(
      {
        ...message,
        data: Buffer.from(
          JSON.stringify({
            ...GcsNotificationFactory.notification().metadata,
            metadata: { grants: "allow everyone" },
          })
        ),
      },
      source
    );
    expect(result.isOk() && result.value?.metadata).not.toHaveProperty(
      "metadata"
    );
    expect(result.isOk() && result.value?.destination.kind).toBe("pod");
  });
});
