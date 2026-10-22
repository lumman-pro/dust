import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import {
  getOrCreateConversationFolder,
  getOrCreatePodFolder,
} from "@app/lib/api/dfs/folders";
import { importGcsFile } from "@app/lib/api/dfs/gcs_import/file";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import type { Authenticator } from "@app/lib/auth";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

interface GcsPodConversationImportContext {
  // Both clients must belong to the authenticated workspace's tenant.
  folders: DfsFolderContext;
  // A regular session for auth, created with createDfsSession.
  client: DfsFileSystemClient;
  signal?: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:security] gcs-pod-conversation-import-access
 * Only import conversations/<conversationId>/files/ objects from the authenticated workspace.
 * The conversation MUST belong to a pod the caller can read before any GCS read or DFS mutation.
 * Standalone conversations MUST be rejected.
 */
/**
 * @cc [owner:flvndvd,label:security] gcs-pod-conversation-import-session
 * Only user and pod folder creation MAY use folders.fs. Conversation directories and file writes
 * MUST use the regular session client. Imports MUST NOT add conversation-local or file-local grants.
 */
export async function importGcsPodConversationFile(
  auth: Authenticator,
  source: GcsReplicationSource,
  { folders, client, signal }: GcsPodConversationImportContext
): Promise<Result<DfsObjectId, Error>> {
  const pathRes = parseGcsReplicationPath(source.objectName);
  if (pathRes.isErr()) {
    return pathRes;
  }

  const path = pathRes.value;
  if (
    !path ||
    path.kind !== "conversation" ||
    path.workspaceId !== source.workspaceId ||
    source.workspaceId !== auth.getNonNullableWorkspace().sId
  ) {
    return new Err(new Error("Invalid GCS source for this workspace."));
  }

  const conversation = await ConversationResource.fetchById(
    auth,
    path.resourceId
  );
  const pod = conversation?.space;
  if (!conversation || !pod?.isProject()) {
    return new Err(new Error("Source pod conversation not found."));
  }
  if (!auth.can("read", pod)) {
    return new Err(
      new Error("Cannot import files into this pod conversation.")
    );
  }

  const sourceRes = await readGcsReplicationSource(source, { signal });
  if (sourceRes.isErr()) {
    return sourceRes;
  }
  if (sourceRes.value.status === "absent") {
    return new Err(
      new Error("GCS source is absent; deletion is not implemented.")
    );
  }

  const { metadata, stream } = sourceRes.value;
  try {
    if (!conversation.dfsObjectId) {
      const podFolderRes = await getOrCreatePodFolder(auth, folders, pod);
      if (podFolderRes.isErr()) {
        return podFolderRes;
      }
    }

    const folderRes = await getOrCreateConversationFolder(
      auth,
      { ...folders, fs: new DfsFileSystem(client) },
      conversation
    );
    if (folderRes.isErr()) {
      return folderRes;
    }

    return await importGcsFile(source, {
      client,
      folderId: folderRes.value,
      path: path.path,
      metadata,
      stream,
      signal,
    });
  } finally {
    stream.destroy();
  }
}
