import { createHash } from "node:crypto";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-source-workflow-identity
 * All notifications for one workspace, bucket and exact object name MUST use the same workflow
 * ID, regardless of event type or versions. The ID MUST fit Temporal's length limit even for
 * maximum-length GCS names. Workspace IDs are also DFS tenant IDs.
 */
export function makeGcsReplicationWorkflowId(
  source: GcsReplicationSource
): string {
  const key = JSON.stringify([
    source.workspaceId,
    source.bucket,
    source.objectName,
  ]);
  return `dfs-gcs-${createHash("sha256").update(key).digest("hex")}`;
}
