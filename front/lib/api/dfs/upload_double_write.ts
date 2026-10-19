import type { Authenticator } from "@app/lib/auth";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import type { FileResource } from "@app/lib/resources/file_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import logger from "@app/logger/logger";
import { getPodFilesBasePath } from "@app/types/mount_path";

// The folder of a pod's dfs folder holding its files, see `dfs/design-docs/URI.md`.
const DFS_FILES_FOLDER_NAME = "files";

/**
 * Double writes to dfs a file uploaded to a pod, once its content is copied to its mount path. Dry
 * run for now: it only logs the dfs write it would do.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] upload-double-write-dry-run
 * It MUST NOT call dfs: it only logs the planned write.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] upload-double-write-scope
 * Only `project_context` files mounted under the files of an existing pod of a workspace with a dfs
 * tenant MUST be logged, with the target path `files/<path below the pod's files>` in the pod's dfs
 * folder. Every other file MUST be ignored.
 */
export async function doubleWriteUploadedFileToDfs(
  auth: Authenticator,
  file: FileResource
): Promise<void> {
  const { useCase, useCaseMetadata, mountFilePath } = file;
  if (useCase !== "project_context" || !useCaseMetadata?.spaceId) {
    return;
  }
  if (!mountFilePath) {
    return;
  }
  const tenant = await DfsTenantResource.fetchByWorkspace(auth);
  if (!tenant) {
    return;
  }
  const space = await SpaceResource.fetchById(auth, useCaseMetadata.spaceId);
  if (!space?.isProject()) {
    return;
  }
  const workspaceId = auth.getNonNullableWorkspace().sId;
  const podFilesBasePath = getPodFilesBasePath({
    workspaceId,
    podId: space.sId,
  });
  if (!mountFilePath.startsWith(podFilesBasePath)) {
    return;
  }

  logger.info(
    {
      workspaceId,
      fileId: file.sId,
      podId: space.sId,
      dfsFolderId: space.dfsObjectId,
      dfsPath: `${DFS_FILES_FOLDER_NAME}/${mountFilePath.slice(podFilesBasePath.length)}`,
      sizeBytes: file.fileSize,
      contentType: file.contentType,
    },
    "Dfs double write dry run: would write an uploaded pod file."
  );
}
