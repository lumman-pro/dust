import { createHash } from "node:crypto";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";

/**
 * @cc [owner:flvndvd,label:concurrency] gcs-source-workflow-identity
 * Use the same workflow ID for a workspace, bucket and exact object name, regardless of event
 * type or versions. The ID MUST fit Temporal's limit even for maximum-length GCS names.
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
