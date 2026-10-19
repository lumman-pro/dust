import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { Authenticator } from "@app/lib/auth";
import type { Result } from "@app/types/shared/result";
import { Context } from "@temporalio/activity";

const HEARTBEAT_INTERVAL_MS = 20_000;

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-importer-fencing
 * The importer MUST hold a renewable source lease through current GCS reads, DFS writes and
 * completion. DFS MUST reject mutations from expired or replaced holders. The importer MUST
 * stop on cancellation or failed renewal and return Err. Ok requires a complete import or a
 * verified skip. Temporal serialization and heartbeats MUST NOT substitute for DFS fencing.
 */
export type GcsReplicationImporter = (
  source: GcsReplicationSource,
  signal: AbortSignal
) => Promise<Result<void, Error>>;

export type GcsReplicationActivities = ReturnType<
  typeof createGcsReplicationActivities
>;

// Bind these activities and register the worker only once the fenced DFS importer exists.
// Requiring the importer here prevents starting a worker that silently discards imports.
export function createGcsReplicationActivities(
  importSource: GcsReplicationImporter
) {
  return {
    /**
     * @cc [owner:flvndvd,label:security] gcs-activity-workspace
     * Every attempt MUST check that the object path belongs to the supplied workspace and recheck
     * dfs_gcs_replication before importing. Failed lookups MUST fail the activity, not skip it.
     */
    async importGcsSourceActivity(source: GcsReplicationSource): Promise<void> {
      const context = Context.current();
      const signal = context.cancellationSignal;
      signal.throwIfAborted();
      const destination = parseGcsReplicationPath(source.objectName);
      if (destination.isErr()) {
        throw destination.error;
      }
      if (destination.value?.workspaceId !== source.workspaceId) {
        throw new Error(
          "GCS source does not belong to the workflow workspace."
        );
      }

      context.heartbeat();
      const heartbeatTimer = setInterval(
        () => context.heartbeat(),
        HEARTBEAT_INTERVAL_MS
      );
      try {
        const auth = await Authenticator.internalAdminForWorkspace(
          source.workspaceId
        );
        const enabled = await auth.hasFeatureFlag("dfs_gcs_replication");
        signal.throwIfAborted();
        if (!enabled) {
          return;
        }
        const imported = await importSource(source, signal);
        signal.throwIfAborted();
        if (imported.isErr()) {
          throw imported.error;
        }
      } finally {
        clearInterval(heartbeatTimer);
      }
    },
  };
}
