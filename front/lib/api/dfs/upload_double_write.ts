import type { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import type { FileResource } from "@app/lib/resources/file_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import logger from "@app/logger/logger";
import type { DfsObjectId } from "@app/types/dfs";
import {
  getConversationFilesBasePath,
  getPodFilesBasePath,
} from "@app/types/mount_path";

// The folder of a pod's or conversation's dfs folder holding its files, see
// `dfs/design-docs/URI.md`.
const DFS_FILES_FOLDER_NAME = "files";

/** The pod or conversation dfs folder an uploaded file is double written to. */
interface UploadDfsFolder {
  owner:
    | { kind: "pod"; podId: string }
    | { kind: "conversation"; conversationId: string };
  // The GCS prefix the owner's files are mounted under.
  filesBasePath: string;
  // `null` until front provisions the folder.
  dfsFolderId: DfsObjectId | null;
}

/**
 * Double writes to dfs a file uploaded to a pod or a conversation, once its content is copied to its
 * mount path. Dry run for now: it only logs the dfs write it would do.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] upload-double-write-dry-run
 * It MUST NOT call dfs: it only logs the planned write.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] upload-double-write-scope
 * Only `project_context` files mounted under the files of an existing pod, and `conversation` files
 * mounted under the files of an existing conversation, of a workspace with a dfs tenant MUST be
 * logged, with the target path `files/<path below the owner's files>` in the owner's dfs folder.
 * Every other file MUST be ignored.
 */
export async function doubleWriteUploadedFileToDfs(
  auth: Authenticator,
  file: FileResource
): Promise<void> {
  const { mountFilePath } = file;
  if (!mountFilePath) {
    return;
  }
  const folder = await getUploadDfsFolder(auth, file);
  if (!folder || !mountFilePath.startsWith(folder.filesBasePath)) {
    return;
  }
  const tenant = await DfsTenantResource.fetchByWorkspace(auth);
  if (!tenant) {
    return;
  }

  logger.info(
    {
      workspaceId: auth.getNonNullableWorkspace().sId,
      fileId: file.sId,
      ...folder.owner,
      dfsFolderId: folder.dfsFolderId,
      dfsPath: `${DFS_FILES_FOLDER_NAME}/${mountFilePath.slice(folder.filesBasePath.length)}`,
      sizeBytes: file.fileSize,
      contentType: file.contentType,
    },
    "Dfs double write dry run: would write an uploaded file."
  );
}

async function getUploadDfsFolder(
  auth: Authenticator,
  file: FileResource
): Promise<UploadDfsFolder | null> {
  const { useCase, useCaseMetadata } = file;
  const workspaceId = auth.getNonNullableWorkspace().sId;

  if (useCase === "project_context" && useCaseMetadata?.spaceId) {
    const space = await SpaceResource.fetchById(auth, useCaseMetadata.spaceId);
    if (!space?.isProject()) {
      return null;
    }
    return {
      owner: { kind: "pod", podId: space.sId },
      filesBasePath: getPodFilesBasePath({ workspaceId, podId: space.sId }),
      dfsFolderId: space.dfsObjectId,
    };
  }

  if (useCase === "conversation" && useCaseMetadata?.conversationId) {
    // The caller already attached the file to this conversation: this only reads its dfs folder.
    const conversation = await ConversationResource.fetchById(
      auth,
      useCaseMetadata.conversationId,
      { dangerouslySkipPermissionFiltering: true }
    );
    if (!conversation) {
      return null;
    }
    return {
      owner: { kind: "conversation", conversationId: conversation.sId },
      filesBasePath: getConversationFilesBasePath({
        workspaceId,
        conversationId: conversation.sId,
      }),
      dfsFolderId: conversation.dfsObjectId,
    };
  }

  return null;
}
