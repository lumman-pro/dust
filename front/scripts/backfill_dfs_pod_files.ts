import { getOrCreatePodFolder } from "@app/lib/api/dfs/folders";
import { Authenticator } from "@app/lib/auth";
import { FileResource } from "@app/lib/resources/file_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { FileModel } from "@app/lib/resources/storage/models/files";
import { SpaceModel } from "@app/lib/resources/storage/models/spaces";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import {
  getDfsBackfillTenant,
  getFirstEditor,
  getSuperuserFolderContext,
  makeUserFolderContextGetter,
  writeMountFileToDfs,
} from "@app/scripts/backfill_dfs_helpers";
import { makeScript } from "@app/scripts/helpers";
import { runOnAllWorkspaces } from "@app/scripts/workspace_helpers";
import { getPodFilesBasePath } from "@app/types/mount_path";
import { Op } from "sequelize";

const BATCH_SIZE_DEFAULT = 200;
const CONCURRENCY_DEFAULT = 4;

makeScript(
  {
    wId: {
      type: "string",
      describe: "Workspace sId to backfill (omit to run on all workspaces).",
    },
    fromWorkspaceModelId: {
      type: "number",
      describe:
        "Skip workspaces with model id below this value (for resuming).",
    },
    batchSize: {
      type: "number",
      default: BATCH_SIZE_DEFAULT,
      describe: "Number of files to fetch per DB query.",
    },
    concurrency: {
      type: "number",
      default: CONCURRENCY_DEFAULT,
      describe: "Pods processed concurrently per batch.",
    },
  },
  async (
    { execute, wId, fromWorkspaceModelId, batchSize, concurrency },
    logger
  ) => {
    await runOnAllWorkspaces(
      async (workspace) => {
        const workspaceId = workspace.sId;
        const auth = await Authenticator.internalAdminForWorkspace(workspaceId);

        const tenant = await getDfsBackfillTenant(auth);
        if (!tenant) {
          logger.info(
            { workspaceId },
            "[backfill_dfs_pod_files] No dfs tenant, skipping workspace"
          );
          return;
        }

        let lastId = 0;
        let written = 0;
        let failed = 0;
        let skippedWithoutMountPath = 0;

        while (true) {
          const rows = await FileModel.findAll({
            attributes: ["id"],
            where: {
              workspaceId: workspace.id,
              useCase: "project_context",
              dfsObjectId: null,
              id: { [Op.gt]: lastId },
            },
            order: [["id", "ASC"]],
            limit: batchSize,
          });
          if (rows.length === 0) {
            break;
          }
          lastId = rows[rows.length - 1].id;

          const files = await FileResource.fetchByModelIdsWithAuth(
            auth,
            rows.map((r) => r.id)
          );
          const filesByPodId = new Map<string, FileResource[]>();
          for (const file of files) {
            const podId = file.useCaseMetadata?.spaceId;
            if (!file.mountFilePath || !podId) {
              skippedWithoutMountPath++;
              continue;
            }
            filesByPodId.set(podId, [...(filesByPodId.get(podId) ?? []), file]);
          }

          const pods = await SpaceResource.fetchByIds(auth, [
            ...filesByPodId.keys(),
          ]);
          const superuserContext = execute
            ? await getSuperuserFolderContext(auth, tenant)
            : null;
          const getUserFolderContext = makeUserFolderContextGetter(
            auth,
            tenant
          );

          await concurrentExecutor(
            pods,
            async (pod) => {
              if (!pod.isProject()) {
                return;
              }
              const basePath = getPodFilesBasePath({
                workspaceId,
                podId: pod.sId,
              });
              // Sandbox function bundles are mounted outside the pod's files folder: not backfilled.
              const podFiles = (filesByPodId.get(pod.sId) ?? []).filter((f) =>
                f.mountFilePath?.startsWith(basePath)
              );
              if (podFiles.length === 0) {
                return;
              }

              if (!superuserContext) {
                for (const file of podFiles) {
                  logger.info(
                    {
                      workspaceId,
                      podId: pod.sId,
                      fileId: file.sId,
                      mountFilePath: file.mountFilePath,
                    },
                    "[backfill_dfs_pod_files] Would write file (dry-run)"
                  );
                }
                written += podFiles.length;
                return;
              }

              const owner = await getFirstEditor(auth, pod);
              if (!owner) {
                logger.warn(
                  { workspaceId, podId: pod.sId },
                  "[backfill_dfs_pod_files] Pod has no editor, skipping"
                );
                failed += podFiles.length;
                return;
              }
              const folderId = await getOrCreatePodFolder(
                auth,
                superuserContext,
                pod,
                { user: owner }
              );
              if (folderId.isErr()) {
                logger.error(
                  { workspaceId, podId: pod.sId, err: folderId.error },
                  "[backfill_dfs_pod_files] Failed to get the pod folder"
                );
                failed += podFiles.length;
                return;
              }
              // Pods whose sanitized names match share a folder under the same owner (see
              // `pod-folder-name`): writing would overwrite the other pod's files.
              const sharingPod = await SpaceModel.findOne({
                attributes: ["id"],
                where: {
                  workspaceId: workspace.id,
                  dfsObjectId: folderId.value,
                  id: { [Op.ne]: pod.id },
                },
                includeDeleted: true,
              });
              if (sharingPod) {
                logger.error(
                  {
                    workspaceId,
                    podId: pod.sId,
                    sharingPodModelId: sharingPod.id,
                  },
                  "[backfill_dfs_pod_files] Pod folder shared with another pod, skipping"
                );
                failed += podFiles.length;
                return;
              }

              const { fs } = await getUserFolderContext(owner);
              for (const file of podFiles) {
                const res = await writeMountFileToDfs(auth, {
                  fs,
                  folderId: folderId.value,
                  basePath,
                  file,
                });
                if (res.isErr()) {
                  logger.error(
                    { workspaceId, fileId: file.sId, err: res.error },
                    "[backfill_dfs_pod_files] Failed to write file"
                  );
                  failed++;
                  continue;
                }
                written++;
              }
            },
            { concurrency }
          );
        }

        logger.info(
          { workspaceId, written, failed, skippedWithoutMountPath, execute },
          "[backfill_dfs_pod_files] Workspace done"
        );
      },
      { wId, fromWorkspaceId: fromWorkspaceModelId }
    );
  }
);
