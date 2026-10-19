import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import type { GcsReplicationActivities } from "@app/temporal/dfs_gcs_replication/activities";
import { reconcileGcsSourceSignal } from "@app/temporal/dfs_gcs_replication/signals";
import {
  continueAsNew,
  proxyActivities,
  setHandler,
  workflowInfo,
} from "@temporalio/workflow";

const { importGcsSourceActivity } = proxyActivities<GcsReplicationActivities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: "1 minute",
  retry: { initialInterval: "1 second", maximumInterval: "1 minute" },
});

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-workflow-pending-import
 * Each run MUST import current state at least once. Signals received during an activity MUST
 * cause another pass. Only one activity may be scheduled at a time. Pending work MUST survive
 * Continue-As-New. No async work may follow the final pending check before workflow completion.
 */
export async function reconcileGcsSourceWorkflow(
  source: GcsReplicationSource
): Promise<void> {
  let pending = true;
  setHandler(reconcileGcsSourceSignal, () => {
    pending = true;
  });

  while (pending) {
    pending = false;
    await importGcsSourceActivity(source);
    if (pending && workflowInfo().continueAsNewSuggested) {
      await continueAsNew<typeof reconcileGcsSourceWorkflow>(source);
    }
  }
}
