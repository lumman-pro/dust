import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { getTemporalClientForFrontNamespace } from "@app/lib/temporal";
import { QUEUE_NAME } from "@app/temporal/dfs_gcs_replication/config";
import { makeGcsReplicationWorkflowId } from "@app/temporal/dfs_gcs_replication/helpers";
import { reconcileGcsSourceSignal } from "@app/temporal/dfs_gcs_replication/signals";
import { reconcileGcsSourceWorkflow } from "@app/temporal/dfs_gcs_replication/workflows";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { WorkflowIdReusePolicy } from "@temporalio/client";

const HANDOFF_TIMEOUT_MS = 30_000;

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-durable-handoff
 * Success MUST mean Temporal accepted the source signal. A closed workflow MUST allow a new run
 * with the same ID. Workflow history MUST contain source identifiers only, not event metadata,
 * credentials or file bytes. An ambiguous RPC failure MUST remain retryable.
 */
export async function launchGcsReplicationWorkflow(
  { workspaceId, bucket, objectName }: GcsReplicationSource,
  signal: AbortSignal
): Promise<Result<void, Error>> {
  const client = await getTemporalClientForFrontNamespace();
  if (signal.aborted) {
    return new Err(normalizeError(signal.reason));
  }
  const source = { workspaceId, bucket, objectName };
  try {
    await client.connection.withDeadline(Date.now() + HANDOFF_TIMEOUT_MS, () =>
      client.connection.withAbortSignal(signal, () =>
        client.workflow.signalWithStart(reconcileGcsSourceWorkflow, {
          args: [source],
          taskQueue: QUEUE_NAME,
          workflowId: makeGcsReplicationWorkflowId(source),
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
          signal: reconcileGcsSourceSignal,
          signalArgs: [],
          memo: { workspaceId: source.workspaceId },
        })
      )
    );
    return new Ok(undefined);
  } catch (error) {
    return new Err(normalizeError(error));
  }
}
