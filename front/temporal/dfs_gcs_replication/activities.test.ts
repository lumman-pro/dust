// @vitest-environment node
import { FeatureFlagResource } from "@app/lib/resources/feature_flag_resource";
import type { GcsReplicationImporter } from "@app/temporal/dfs_gcs_replication/activities";
import { createGcsReplicationActivities } from "@app/temporal/dfs_gcs_replication/activities";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import type { WorkspaceType } from "@app/types/user";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const context = vi.hoisted(() => ({
  cancellationSignal: new AbortController().signal,
  heartbeat: vi.fn(),
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/activity")>()),
  Context: { current: () => context },
}));

describe("importGcsSourceActivity", () => {
  let workspace: WorkspaceType;
  let stop: AbortController;
  const importer = vi.fn<GcsReplicationImporter>();
  const { importGcsSourceActivity } = createGcsReplicationActivities(importer);

  beforeEach(async () => {
    workspace = await WorkspaceFactory.basic();
    await FeatureFlagResource.enable(workspace, "dfs_gcs_replication");
    stop = new AbortController();
    context.cancellationSignal = stop.signal;
    context.heartbeat.mockClear();
    importer.mockReset().mockResolvedValue(new Ok(undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("rechecks the workspace flag before each attempt", async () => {
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/pod/files/report.txt`,
    });
    await importGcsSourceActivity(source);
    expect(importer).toHaveBeenCalledExactlyOnceWith(source, stop.signal);

    await FeatureFlagResource.disable(workspace, "dfs_gcs_replication");
    await importGcsSourceActivity(source);
    expect(importer).toHaveBeenCalledOnce();
  });

  it("rejects an object from another workspace before importing", async () => {
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
    });
    await expect(importGcsSourceActivity(source)).rejects.toThrow(
      "does not belong"
    );
    expect(importer).not.toHaveBeenCalled();
  });

  it("fails a missing workspace lookup instead of treating its flag as disabled", async () => {
    await expect(
      importGcsSourceActivity(GcsNotificationFactory.replicationSource())
    ).rejects.toThrow();
    expect(importer).not.toHaveBeenCalled();
  });

  it("throws importer failures for Temporal to retry", async () => {
    const error = new Error("source lease lost");
    importer.mockResolvedValue(new Err(error));
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/pod/files/report.txt`,
    });
    await expect(importGcsSourceActivity(source)).rejects.toBe(error);
  });

  it("heartbeats during an import and rejects success after cancellation", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = Promise.withResolvers<Result<void, Error>>();
    importer.mockReturnValue(pending.promise);
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/pod/files/report.txt`,
    });
    const running = importGcsSourceActivity(source);
    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    expect(importer.mock.calls[0][1]).toBe(stop.signal);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(context.heartbeat).toHaveBeenCalledTimes(2);

    stop.abort(new Error("activity timed out"));
    const result = expect(running).rejects.toThrow("activity timed out");
    pending.resolve(new Ok(undefined));
    await result;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(context.heartbeat).toHaveBeenCalledTimes(2);
  });
});
