// @vitest-environment node
import { getTemporalClientForFrontNamespace } from "@app/lib/temporal";
import { launchGcsReplicationWorkflow } from "@app/temporal/dfs_gcs_replication/client";
import { makeGcsReplicationWorkflowId } from "@app/temporal/dfs_gcs_replication/helpers";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { WorkflowIdReusePolicy } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";

const source = GcsNotificationFactory.replicationSource();

describe("launchGcsReplicationWorkflow", () => {
  it("signals the same source workflow on redelivery and allows restarting a closed run", async () => {
    const client = await getTemporalClientForFrontNamespace();
    const signal = new AbortController().signal;
    const sourceWithMetadata = {
      ...source,
      generation: "123",
      contentType: "text/plain",
    };
    expect(
      (await launchGcsReplicationWorkflow(sourceWithMetadata, signal)).isOk()
    ).toBe(true);
    expect(
      (await launchGcsReplicationWorkflow({ ...source }, signal)).isOk()
    ).toBe(true);

    const calls = vi.mocked(client.workflow.signalWithStart).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toEqual(calls[1][1]);
    expect(calls[0][1]).toMatchObject({
      args: [source],
      signalArgs: [],
      workflowId: makeGcsReplicationWorkflowId(source),
      workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
    });
    expect(client.connection.withDeadline).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.connection.withAbortSignal).mock.calls[0][0]).toBe(
      signal
    );
  });

  it("does not signal after cancellation", async () => {
    const client = await getTemporalClientForFrontNamespace();
    const result = await launchGcsReplicationWorkflow(
      source,
      AbortSignal.abort()
    );
    expect(result.isErr()).toBe(true);
    expect(client.workflow.signalWithStart).not.toHaveBeenCalled();
  });
});

describe("makeGcsReplicationWorkflowId", () => {
  it("distinguishes tenants, buckets and exact object names with bounded IDs", () => {
    const variants = [
      source,
      { ...source, workspaceId: "other" },
      { ...source, bucket: "other" },
      { ...source, objectName: `${source.objectName}/a` },
      { ...source, objectName: `${source.objectName}%2Fa` },
      { ...source, objectName: "a".repeat(1024) },
    ];
    const ids = variants.map(makeGcsReplicationWorkflowId);
    expect(new Set(ids).size).toBe(variants.length);
    expect(ids.every((id) => id.length < 255)).toBe(true);
  });
});
