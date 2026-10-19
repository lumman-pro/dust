// @vitest-environment node
import { reconcileGcsSourceWorkflow } from "@app/temporal/dfs_gcs_replication/workflows";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  importGcsSourceActivity: vi.fn<() => Promise<void>>(),
  setHandler: vi.fn<(_signal: unknown, handler: () => void) => void>(),
  workflowInfo: vi.fn(() => ({ continueAsNewSuggested: false })),
  continueAsNew: vi.fn(),
}));

vi.mock("@temporalio/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/workflow")>()),
  proxyActivities: () => ({
    importGcsSourceActivity: runtime.importGcsSourceActivity,
  }),
  setHandler: runtime.setHandler,
  workflowInfo: runtime.workflowInfo,
  continueAsNew: runtime.continueAsNew,
}));

const source = GcsNotificationFactory.replicationSource();

describe("reconcileGcsSourceWorkflow", () => {
  beforeEach(() => {
    runtime.importGcsSourceActivity.mockReset().mockResolvedValue(undefined);
    runtime.setHandler.mockClear();
    runtime.workflowInfo.mockReturnValue({ continueAsNewSuggested: false });
    runtime.continueAsNew.mockReset();
  });

  it("imports once on every new run, including Continue-As-New runs without an initial signal", async () => {
    await reconcileGcsSourceWorkflow(source);
    expect(runtime.importGcsSourceActivity).toHaveBeenCalledExactlyOnceWith(
      source
    );
  });

  it("coalesces signals during an import into one subsequent pass", async () => {
    const active = Promise.withResolvers<void>();
    runtime.importGcsSourceActivity.mockReturnValueOnce(active.promise);
    const running = reconcileGcsSourceWorkflow(source);
    const signal = runtime.setHandler.mock.calls[0][1];

    signal();
    signal();
    expect(runtime.importGcsSourceActivity).toHaveBeenCalledOnce();
    active.resolve();
    await running;
    expect(runtime.importGcsSourceActivity).toHaveBeenCalledTimes(2);
  });

  it("carries pending work into a new run when history needs to roll over", async () => {
    const active = Promise.withResolvers<void>();
    const continued = new Error("Continue-As-New");
    runtime.importGcsSourceActivity.mockReturnValueOnce(active.promise);
    runtime.workflowInfo.mockReturnValue({ continueAsNewSuggested: true });
    runtime.continueAsNew.mockRejectedValue(continued);
    const running = reconcileGcsSourceWorkflow(source);
    const result = expect(running).rejects.toBe(continued);

    runtime.setHandler.mock.calls[0][1]();
    active.resolve();
    await result;
    expect(runtime.continueAsNew).toHaveBeenCalledExactlyOnceWith(source);
    expect(runtime.importGcsSourceActivity).toHaveBeenCalledOnce();
  });
});
