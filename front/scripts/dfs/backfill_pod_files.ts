import { importGcsPodFile } from "@app/lib/api/dfs/gcs_import/pod";
import { Authenticator } from "@app/lib/auth";
import { SpaceResource } from "@app/lib/resources/space_resource";
import type { UserResource } from "@app/lib/resources/user_resource";
import type { Logger } from "@app/logger/logger";
import type { DfsBackfillCounts } from "@app/scripts/dfs/backfill_helpers";
import {
  listGcsReplicationSources,
  listGcsResourceIds,
  withGcsImportContext,
} from "@app/scripts/dfs/backfill_helpers";
import { makeScript } from "@app/scripts/helpers";
import { runOnAllWorkspaces } from "@app/scripts/workspace_helpers";
import { Ok } from "@app/types/shared/result";
import type { LightWorkspaceType } from "@app/types/user";

const CONCURRENCY_DEFAULT = 4;

// The default owner of the pod folder in `getOrCreatePodFolder`. As an editor, they can write the
// pod and its dfs folder.
async function getFirstEditor(
  auth: Authenticator,
  pod: SpaceResource
): Promise<UserResource | null> {
  const editors = await pod.fetchActiveEditorUsers(auth);
  return editors.sort((a, b) => a.id - b.id)[0] ?? null;
}

// `pod` is null when no pod of the workspace has the ID of this GCS folder.
async function backfillPodFiles(
  auth: Authenticator,
  { podId, pod }: { podId: string; pod: SpaceResource | null },
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<DfsBackfillCounts> {
  const workspaceId = auth.getNonNullableWorkspace().sId;
  const sources = await listGcsReplicationSources(workspaceId, "pods", podId);
  if (sources.length === 0) {
    return { imported: 0, failed: 0, skipped: 0 };
  }

  if (!pod?.isProject()) {
    logger.info(
      { workspaceId, podId, files: sources.length },
      "[backfill_dfs_pod_files] Pod not found, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }
  const editor = await getFirstEditor(auth, pod);
  if (!editor) {
    logger.warn(
      { workspaceId, podId, files: sources.length },
      "[backfill_dfs_pod_files] Pod has no editor, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }

  if (!execute) {
    for (const { objectName } of sources) {
      logger.info(
        { workspaceId, podId, objectName },
        "[backfill_dfs_pod_files] Would import file (dry-run)"
      );
    }
    return { imported: sources.length, failed: 0, skipped: 0 };
  }

  const editorAuth = await Authenticator.fromUserIdAndWorkspaceId(
    editor.sId,
    workspaceId
  );
  const counts = await withGcsImportContext(editorAuth, async (context) => {
    let imported = 0;
    let failed = 0;
    for (const source of sources) {
      const res = await importGcsPodFile(editorAuth, source, context);
      if (res.isErr()) {
        logger.error(
          { workspaceId, podId, objectName: source.objectName, err: res.error },
          "[backfill_dfs_pod_files] Failed to import file"
        );
        failed++;
        continue;
      }
      imported++;
    }
    return new Ok({ imported, failed, skipped: 0 });
  });
  if (counts.isErr()) {
    logger.error(
      { workspaceId, podId, err: counts.error },
      "[backfill_dfs_pod_files] Failed to open the dfs sessions"
    );
    return { imported: 0, failed: sources.length, skipped: 0 };
  }
  return counts.value;
}

async function backfillWorkspace(
  workspace: LightWorkspaceType,
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<void> {
  const workspaceId = workspace.sId;
  const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

  const replicationEnabled = await auth.hasFeatureFlag("dfs_gcs_replication");
  if (!replicationEnabled) {
    logger.info(
      { workspaceId },
      "[backfill_dfs_pod_files] Replication disabled, skipping workspace"
    );
    return;
  }
  const podIds = await listGcsResourceIds(workspaceId, "pods");
  const pods = await SpaceResource.fetchByIds(auth, podIds);
  const podsById = new Map(pods.map((pod) => [pod.sId, pod]));
  const counts: DfsBackfillCounts = { imported: 0, failed: 0, skipped: 0 };
  // One pod at a time: concurrent first imports of pods with the same first editor may fail
  // creating their user folder (see `stored-folder-first`).
  for (const podId of podIds) {
    const podCounts = await backfillPodFiles(
      auth,
      { podId, pod: podsById.get(podId) ?? null },
      { execute, logger }
    );
    counts.imported += podCounts.imported;
    counts.failed += podCounts.failed;
    counts.skipped += podCounts.skipped;
  }

  logger.info(
    { workspaceId, ...counts, execute },
    "[backfill_dfs_pod_files] Workspace done"
  );
}

makeScript(
  {
    wId: {
      type: "string",
      describe: "Workspace ID to backfill (omit to run on all workspaces).",
    },
    fromWorkspaceModelId: {
      type: "number",
      describe:
        "Skip workspaces with model id below this value (for resuming).",
    },
    concurrency: {
      type: "number",
      default: CONCURRENCY_DEFAULT,
      describe: "Workspaces backfilled concurrently.",
    },
  },
  async ({ execute, wId, fromWorkspaceModelId, concurrency }, logger) => {
    await runOnAllWorkspaces(
      (workspace) => backfillWorkspace(workspace, { execute, logger }),
      { wId, fromWorkspaceId: fromWorkspaceModelId, concurrency }
    );
  }
);
