// @vitest-environment node
import type { GcsReplicationImporter } from "@app/lib/api/dfs/gcs_worker";
import { runGcsReplicationWorker } from "@app/lib/api/dfs/gcs_worker";
import { FeatureFlagResource } from "@app/lib/resources/feature_flag_resource";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import {
  FakePubSub,
  FakePubSubMessage,
} from "@app/tests/utils/mocks/gcs_pubsub";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { WorkspaceType } from "@app/types/user";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@google-cloud/pubsub", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google-cloud/pubsub")>();
  const { FakePubSub } = await import("@app/tests/utils/mocks/gcs_pubsub");
  return { ...actual, PubSub: FakePubSub };
});

const subscriptionName = "projects/test-project/subscriptions/dfs-import";
const source = GcsNotificationFactory.source;

describe("runGcsReplicationWorker", () => {
  let stop: AbortController;
  let workspace: WorkspaceType;

  beforeEach(async () => {
    FakePubSub.instances = [];
    stop = new AbortController();
    workspace = await WorkspaceFactory.basic();
    await FeatureFlagResource.enable(workspace, "dfs_gcs_replication");
  });

  afterEach(() => {
    stop.abort();
    vi.useRealTimers();
  });

  it("acknowledges only after the importer completes", async () => {
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    client.subscriber.deliver(message);
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    pending.resolve(new Ok(undefined));
    await vi.waitFor(() => expect(message.ack).toHaveBeenCalledOnce());
    expect(message.nack).not.toHaveBeenCalled();

    stop.abort();
    expect((await running).isOk()).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("acknowledges canonical uploads without invoking the importer", async () => {
    const importNotification = vi.fn<GcsReplicationImporter>();
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      metadata: { name: "files/w/workspace/original.txt" },
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(importNotification).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it.each(["pods", "conversations"])(
    "ignores %s files when only another workspace has the flag",
    async (folder) => {
      const disabledWorkspace = await WorkspaceFactory.basic();
      const importNotification = vi.fn<GcsReplicationImporter>();
      const running = runGcsReplicationWorker({
        subscriptionName,
        source,
        importNotification,
        signal: stop.signal,
      });
      const envelope = GcsNotificationFactory.message({
        metadata: {
          name: `w/${disabledWorkspace.sId}/${folder}/resource/files/report.txt`,
        },
      });
      const message = new FakePubSubMessage(envelope.attributes, envelope.data);

      FakePubSub.latest().subscriber.deliver(message);
      await vi.waitFor(() => expect(message.ack).toHaveBeenCalledOnce());
      expect(importNotification).not.toHaveBeenCalled();
      expect(message.nack).not.toHaveBeenCalled();
      stop.abort();
      expect((await running).isOk()).toBe(true);
    }
  );

  it("checks the flag again for the next delivery", async () => {
    const importNotification = vi.fn<GcsReplicationImporter>(
      async () => new Ok(undefined)
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const first = new FakePubSubMessage(envelope.attributes, envelope.data);
    const second = new FakePubSubMessage(
      envelope.attributes,
      envelope.data,
      "message-2"
    );
    const subscriber = FakePubSub.latest().subscriber;

    subscriber.deliver(first);
    await vi.waitFor(() => expect(first.ack).toHaveBeenCalledOnce());
    expect(importNotification).toHaveBeenCalledOnce();
    await FeatureFlagResource.disable(workspace, "dfs_gcs_replication");
    subscriber.deliver(second);
    await vi.waitFor(() => expect(second.ack).toHaveBeenCalledOnce());
    expect(importNotification).toHaveBeenCalledOnce();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("nacks when the workspace for the flag lookup cannot be resolved", async () => {
    const importNotification = vi.fn<GcsReplicationImporter>();
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message();
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    await vi.waitFor(() => expect(message.nack).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    expect(importNotification).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("nacks invalid notifications without invoking the importer", async () => {
    const importNotification = vi.fn<GcsReplicationImporter>();
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const message = new FakePubSubMessage({}, Buffer.from("{}"));

    FakePubSub.latest().subscriber.deliver(message);
    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(importNotification).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it.each([false, true])(
    "nacks failed imports, including unexpected exceptions (throws: %s)",
    async (throws) => {
      const importNotification: GcsReplicationImporter = async () => {
        if (throws) {
          throw new Error("unexpected failure");
        }
        return new Err(new Error("import failed"));
      };
      const running = runGcsReplicationWorker({
        subscriptionName,
        source,
        importNotification,
        signal: stop.signal,
      });
      const envelope = GcsNotificationFactory.message({
        workspaceId: workspace.sId,
      });
      const message = new FakePubSubMessage(envelope.attributes, envelope.data);

      FakePubSub.latest().subscriber.deliver(message);
      await vi.waitFor(() => expect(message.nack).toHaveBeenCalledOnce());
      expect(message.ack).not.toHaveBeenCalled();
      stop.abort();
      expect((await running).isOk()).toBe(true);
    }
  );

  it("rejects new deliveries while allowing an active import to finish during shutdown", async () => {
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const finishClose = client.subscriber.holdClose();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const active = new FakePubSubMessage(envelope.attributes, envelope.data);
    const late = new FakePubSubMessage(
      envelope.attributes,
      envelope.data,
      "message-2"
    );

    client.subscriber.deliver(active);
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    stop.abort();
    client.subscriber.deliver(late);
    expect(late.nack).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    expect(client.close).not.toHaveBeenCalled();
    pending.resolve(new Ok(undefined));
    await vi.waitFor(() => expect(active.ack).toHaveBeenCalledOnce());
    finishClose();
    expect((await running).isOk()).toBe(true);
  });

  it("cancels an import after the drain timeout and never acknowledges its late success", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const finishClose = client.subscriber.holdClose();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    client.subscriber.deliver(message);
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    const importSignal = importNotification.mock.calls[0][1];
    stop.abort();
    expect(importSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(importSignal.aborted).toBe(true);
    pending.resolve(new Ok(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    finishClose();
    expect((await running).isOk()).toBe(true);
  });

  it("fails shutdown if the SDK closes while an import is still active", async () => {
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    stop.abort();
    expect((await running).isErr()).toBe(true);
    pending.resolve(new Ok(undefined));
    await vi.waitFor(() => expect(message.nack).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("returns subscription failures and closes both clients", async () => {
    const importNotification = vi.fn<GcsReplicationImporter>();
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const error = new Error("subscription unavailable");

    client.subscriber.emit("error", error);
    const result = await running;
    expect(result.isErr() && result.error).toBe(error);
    expect(client.subscriber.close).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("returns subscription failures that occur during shutdown", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification: vi.fn(),
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const finishClose = client.subscriber.holdClose();
    stop.abort();
    const error = new Error("subscription failed during close");
    client.subscriber.emit("error", error);
    finishClose();

    const result = await running;
    expect(result.isErr() && result.error).toBe(error);
  });

  it("fails when the subscription closes unexpectedly", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification: vi.fn(),
      signal: stop.signal,
    });
    FakePubSub.latest().subscriber.emit("close");

    expect((await running).isErr()).toBe(true);
  });

  it("cancels work when its processing deadline expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);
    FakePubSub.latest().subscriber.deliver(message);

    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledOnce());
    const importSignal = importNotification.mock.calls[0][1];
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(importSignal.aborted).toBe(true);
    pending.resolve(new Ok(undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.nack).toHaveBeenCalledOnce();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("bounds active imports even if the SDK delivers more messages than configured", async () => {
    const pending = Promise.withResolvers<Result<void, Error>>();
    const importNotification = vi.fn<GcsReplicationImporter>(
      () => pending.promise
    );
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const messages = Array.from(
      { length: 9 },
      (_, index) =>
        new FakePubSubMessage(envelope.attributes, envelope.data, String(index))
    );

    for (const message of messages) {
      client.subscriber.deliver(message);
    }
    await vi.waitFor(() => expect(importNotification).toHaveBeenCalledTimes(8));
    expect(messages[8].nack).toHaveBeenCalledOnce();
    pending.resolve(new Ok(undefined));
    await vi.waitFor(() => expect(messages[7].ack).toHaveBeenCalledOnce());
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("does not connect when already stopped", async () => {
    stop.abort();
    const result = await runGcsReplicationWorker({
      subscriptionName,
      source,
      importNotification: vi.fn(),
      signal: stop.signal,
    });
    expect(result.isOk()).toBe(true);
    expect(FakePubSub.instances).toHaveLength(0);
  });

  it("rejects an unqualified subscription name before connecting", async () => {
    const result = await runGcsReplicationWorker({
      subscriptionName: "dfs-import",
      source,
      importNotification: vi.fn(),
      signal: stop.signal,
    });
    expect(result.isErr()).toBe(true);
    expect(FakePubSub.instances).toHaveLength(0);
  });
});
