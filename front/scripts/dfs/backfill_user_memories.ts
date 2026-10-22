import { importGcsUserFile } from "@app/lib/api/dfs/gcs_import/user";
import { Authenticator } from "@app/lib/auth";
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

async function backfillUserFiles(
  workspace: LightWorkspaceType,
  userId: string,
  { execute, logger }: { execute: boolean; logger: Logger }
): Promise<DfsBackfillCounts> {
  const workspaceId = workspace.sId;
  const sources = await listGcsReplicationSources(workspaceId, "users", userId);
  if (sources.length === 0) {
    return { imported: 0, failed: 0, skipped: 0 };
  }

  const userAuth = await Authenticator.fromUserIdAndWorkspaceId(
    userId,
    workspaceId
  );
  if (!userAuth.isUser()) {
    logger.info(
      { workspaceId, userId, files: sources.length },
      "[backfill_dfs_user_memories] Not a workspace member, skipping"
    );
    return { imported: 0, failed: 0, skipped: sources.length };
  }

  if (!execute) {
    for (const { objectName } of sources) {
      logger.info(
        { workspaceId, userId, objectName },
        "[backfill_dfs_user_memories] Would import file (dry-run)"
      );
    }
    return { imported: sources.length, failed: 0, skipped: 0 };
  }

  const counts = await withGcsImportContext(userAuth, async (context) => {
    let imported = 0;
    let failed = 0;
    for (const source of sources) {
      const res = await importGcsUserFile(userAuth, source, context);
      if (res.isErr()) {
        logger.error(
          {
            workspaceId,
            userId,
            objectName: source.objectName,
            err: res.error,
          },
          "[backfill_dfs_user_memories] Failed to import file"
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
      { workspaceId, userId, err: counts.error },
      "[backfill_dfs_user_memories] Failed to open the dfs sessions"
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
      "[backfill_dfs_user_memories] Replication disabled, skipping workspace"
    );
    return;
  }
  const userIds = await listGcsResourceIds(workspaceId, "users");
  const counts: DfsBackfillCounts = { imported: 0, failed: 0, skipped: 0 };
  // One user at a time: concurrent first imports may fail creating the workspace's dfs tenant.
  for (const userId of userIds) {
    const userCounts = await backfillUserFiles(workspace, userId, {
      execute,
      logger,
    });
    counts.imported += userCounts.imported;
    counts.failed += userCounts.failed;
    counts.skipped += userCounts.skipped;
  }

  logger.info(
    { workspaceId, ...counts, execute },
    "[backfill_dfs_user_memories] Workspace done"
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
