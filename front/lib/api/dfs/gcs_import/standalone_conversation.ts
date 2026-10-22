import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { getOrCreateConversationFolder } from "@app/lib/api/dfs/folders";
import { importGcsFile } from "@app/lib/api/dfs/gcs_import/file";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import type { Authenticator } from "@app/lib/auth";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import type { DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

interface GcsStandaloneConversationImportContext {
  // Both clients must belong to the authenticated workspace's tenant.
  folders: DfsFolderContext;
  // A regular session for the conversation creator, created with createDfsSession.
  client: DfsFileSystemClient;
  signal?: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:security] gcs-standalone-conversation-access
 * Import only root standalone conversations in the authenticated workspace, as their first
 * participant (creator). The creator MUST still be an active member with access to the conversation.
 * Delegate folder grants to `getOrCreateConversationFolder`.
 */
/**
 * @cc [owner:flvndvd,label:concurrency] gcs-standalone-conversation-activation
 * Require exclusive access to the GCS source, DFS destination and conversation folder, including
 * grant changes. Do not register this importer with Temporal until DFS writes and grants are fenced
 * and the shared folder helper filters eligible participants and recovers interrupted grant writes.
 */
export async function importGcsStandaloneConversationFile(
  auth: Authenticator,
  source: GcsReplicationSource,
  { folders, client, signal }: GcsStandaloneConversationImportContext
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
  if (
    !conversation ||
    conversation.spaceId !== null ||
    conversation.depth !== 0
  ) {
    return new Err(new Error("Source standalone conversation not found."));
  }

  const user = auth.user();
  const participants = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  if (!user || participants[0]?.userId !== user.id) {
    return new Err(
      new Error("Import requires the conversation creator's session.")
    );
  }

  const [activeCreator] = await MembershipResource.filterActiveMembers({
    workspace: auth.getNonNullableWorkspace(),
    users: [user],
  });
  if (!activeCreator) {
    return new Err(new Error("Conversation creator no longer has access."));
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
    const folderRes = await getOrCreateConversationFolder(
      auth,
      { ...folders, fs: new DfsFileSystem(client) },
      conversation,
      { user }
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
