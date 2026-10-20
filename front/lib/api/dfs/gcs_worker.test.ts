// @vitest-environment node
import { runGcsReplicationWorker } from "@app/lib/api/dfs/gcs_worker";
import { FeatureFlagResource } from "@app/lib/resources/feature_flag_resource";
import { getTemporalClientForFrontNamespace } from "@app/lib/temporal";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import {
  FakePubSub,
  FakePubSubMessage,
} from "@app/tests/utils/mocks/gcs_pubsub";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
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
  const handoff = vi.fn();

  beforeEach(async () => {
    FakePubSub.instances = [];
    stop = new AbortController();
    workspace = await WorkspaceFactory.basic();
    await FeatureFlagResource.enable(workspace, "dfs_gcs_replication");
    const client = await getTemporalClientForFrontNamespace();
    handoff.mockReset().mockResolvedValue(undefined);
    vi.mocked(client.workflow.signalWithStart).mockImplementation(handoff);
  });

  afterEach(() => {
    stop.abort();
    vi.useRealTimers();
  });

  it("acknowledges only after Temporal accepts the signal", async () => {
    const pending = Promise.withResolvers<void>();
    handoff.mockReturnValue(pending.promise);
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    client.subscriber.deliver(message);
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitFor(() => expect(message.ack).toHaveBeenCalledOnce());
    expect(message.nack).not.toHaveBeenCalled();

    stop.abort();
    expect((await running).isOk()).toBe(true);
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("acknowledges canonical uploads without signaling Temporal", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      metadata: { name: "files/w/workspace/original.txt" },
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(handoff).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it.each(["pods", "conversations"])(
    "ignores %s files when only another workspace has the flag",
    async (folder) => {
      const disabledWorkspace = await WorkspaceFactory.basic();

      const running = runGcsReplicationWorker({
        subscriptionName,
        source,
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
      expect(handoff).not.toHaveBeenCalled();
      expect(message.nack).not.toHaveBeenCalled();
      stop.abort();
      expect((await running).isOk()).toBe(true);
    }
  );

  it("checks the flag again for the next delivery", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
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
    expect(handoff).toHaveBeenCalledOnce();
    await FeatureFlagResource.disable(workspace, "dfs_gcs_replication");
    subscriber.deliver(second);
    await vi.waitFor(() => expect(second.ack).toHaveBeenCalledOnce());
    expect(handoff).toHaveBeenCalledOnce();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("nacks when the workspace for the flag lookup cannot be resolved", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message();
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    await vi.waitFor(() => expect(message.nack).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("nacks invalid notifications without signaling Temporal", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const message = new FakePubSubMessage({}, Buffer.from("{}"));

    FakePubSub.latest().subscriber.deliver(message);
    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    expect(handoff).not.toHaveBeenCalled();
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it.each(["connection", "signal"])(
    "nacks a failed Temporal %s request",
    async (failure) => {
      const error = new Error("Temporal unavailable");
      if (failure === "connection") {
        vi.mocked(getTemporalClientForFrontNamespace).mockRejectedValueOnce(
          error
        );
      } else {
        handoff.mockRejectedValueOnce(error);
      }
      const running = runGcsReplicationWorker({
        subscriptionName,
        source,
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

  it("rejects new deliveries while allowing an active handoff to finish during shutdown", async () => {
    const pending = Promise.withResolvers<void>();
    handoff.mockReturnValue(pending.promise);
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
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
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    stop.abort();
    client.subscriber.deliver(late);
    expect(late.nack).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    expect(client.close).not.toHaveBeenCalled();
    pending.resolve();
    await vi.waitFor(() => expect(active.ack).toHaveBeenCalledOnce());
    finishClose();
    expect((await running).isOk()).toBe(true);
  });

  it("cancels a handoff after the drain timeout and never acknowledges its late acceptance", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = Promise.withResolvers<void>();
    handoff.mockReturnValue(pending.promise);
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const client = FakePubSub.latest();
    const finishClose = client.subscriber.holdClose();
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    client.subscriber.deliver(message);
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    const temporalClient = await getTemporalClientForFrontNamespace();
    const handoffSignal = vi.mocked(temporalClient.connection.withAbortSignal)
      .mock.calls[0][0];
    stop.abort();
    expect(handoffSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(handoffSignal.aborted).toBe(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(message.nack).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
    finishClose();
    expect((await running).isOk()).toBe(true);
  });

  it("fails shutdown if the SDK closes while a handoff is still active", async () => {
    const pending = Promise.withResolvers<void>();
    handoff.mockReturnValue(pending.promise);
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    const envelope = GcsNotificationFactory.message({
      workspaceId: workspace.sId,
    });
    const message = new FakePubSubMessage(envelope.attributes, envelope.data);

    FakePubSub.latest().subscriber.deliver(message);
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledOnce());
    stop.abort();
    expect((await running).isErr()).toBe(true);
    pending.resolve();
    await vi.waitFor(() => expect(message.nack).toHaveBeenCalledOnce());
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("returns subscription failures and closes both clients", async () => {
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
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
      signal: stop.signal,
    });
    FakePubSub.latest().subscriber.emit("close");

    expect((await running).isErr()).toBe(true);
  });

  it("bounds active handoffs even if the SDK delivers more messages than configured", async () => {
    const pending = Promise.withResolvers<void>();
    handoff.mockReturnValue(pending.promise);
    const running = runGcsReplicationWorker({
      subscriptionName,
      source,
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
    await vi.waitFor(() => expect(handoff).toHaveBeenCalledTimes(8));
    expect(messages[8].nack).toHaveBeenCalledOnce();
    pending.resolve();
    await vi.waitFor(() => expect(messages[7].ack).toHaveBeenCalledOnce());
    stop.abort();
    expect((await running).isOk()).toBe(true);
  });

  it("does not connect when already stopped", async () => {
    stop.abort();
    const result = await runGcsReplicationWorker({
      subscriptionName,
      source,
      signal: stop.signal,
    });
    expect(result.isOk()).toBe(true);
    expect(FakePubSub.instances).toHaveLength(0);
  });

  it("rejects an unqualified subscription name before connecting", async () => {
    const result = await runGcsReplicationWorker({
      subscriptionName: "dfs-import",
      source,
      signal: stop.signal,
    });
    expect(result.isErr()).toBe(true);
    expect(FakePubSub.instances).toHaveLength(0);
  });
});
