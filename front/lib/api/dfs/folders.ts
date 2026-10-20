import { createUserSubject } from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { DfsFileSystem } from "@app/lib/dfs/file_system";
import {
  conversationFolderUri,
  podFolderNames,
  podFolderUri,
  userFolderUri,
} from "@app/lib/dfs/folders";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsUserFolderResource } from "@app/lib/resources/dfs_user_folder_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import type { DfsObjectId } from "@app/types/dfs";
import { DfsError, isDfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

/**
 * @cc [owner:fabiencelier,label:product] folder-mime-types
 * Pod and conversation folders created by `getOrCreatePodFolder` and `getOrCreateConversationFolder`
 * MUST get `DFS_POD_FOLDER_MIME_TYPE` and `DFS_CONVERSATION_FOLDER_MIME_TYPE`, so that clients can
 * recognize them wherever they are. Changing a value leaves existing folders with the previous one.
 */
export const DFS_POD_FOLDER_MIME_TYPE = "application/vnd.dust.pod";
// The pod's actual name, since its folder's name is encoded (see `podFolderNames`).
export const DFS_DISPLAY_NAME_XATTR = "dust.display_name";
// The sId of the pod a folder was created for, to tell it apart from a folder of another pod with
// the same name.
export const DFS_POD_ID_XATTR = "dust.pod_id";

export const DFS_CONVERSATION_FOLDER_MIME_TYPE =
  "application/vnd.dust.conversation";

export interface DfsFolderContext {
  // The file system the folders are created with.
  fs: DfsFileSystem;
  // Authenticated with the tenant key of the authenticated workspace, to set grants.
  tenantClient: Pick<DfsClient, "updateGrants">;
  // The tenant root (`DfsTenantResource.rootId`).
  rootId: DfsObjectId;
}

/** The folder at `uri`, created if missing. `created` is false when it already existed. */
async function ensureFolder(
  fs: DfsFileSystem,
  uri: string,
  options: { mimeType?: string; xattrs?: Record<string, Uint8Array> } = {}
): Promise<Result<{ id: DfsObjectId; created: boolean }, DfsError>> {
  const made = await fs.mkdir(uri, options);
  if (made.isOk()) {
    return realId(made.value.attr.id, true);
  }
  if (made.error.code !== "already_exists") {
    return made;
  }
  const existing = await fs.stat(uri);
  if (existing.isErr()) {
    return existing;
  }
  if (!existing.value) {
    return new Err(new DfsError("not_found", `Not found: ${uri}.`));
  }
  if (existing.value.attr.kind !== "directory") {
    return new Err(new DfsError("not_directory", `Not a folder: ${uri}.`));
  }
  return realId(existing.value.attr.id, false);
}

function realId(
  id: string,
  created: boolean
): Result<{ id: DfsObjectId; created: boolean }, DfsError> {
  return isDfsObjectId(id)
    ? new Ok({ id, created })
    : new Err(new DfsError("invalid_response", "Expected a real object."));
}

/**
 * @cc [owner:fabiencelier,label:backend] stored-folder-first
 * The `getOrCreate*Folder` functions MUST return the stored folder ID when there is one, without
 * calling dfs. Otherwise they MUST create the folder if missing, reuse it if it exists, store its
 * ID unless a concurrent call stored one first, and return the stored ID. Concurrent first calls
 * for the same user folder MAY fail on the unique `(workspaceId, userId)` index instead.
 */

/**
 * The folder of `user` (`users/<userSId>` under the tenant root). A folder created here is only
 * accessible to `user`.
 */
export async function getOrCreateUserFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  user: UserResource
): Promise<Result<DfsObjectId, DfsError>> {
  const stored = await DfsUserFolderResource.fetchByUser(auth, user);
  if (stored) {
    return new Ok(stored.dfsObjectId);
  }
  const folder = await ensureFolder(
    context.fs,
    userFolderUri(context.rootId, user.sId)
  );
  if (folder.isErr()) {
    return folder;
  }
  if (folder.value.created) {
    const granted = await context.tenantClient.updateGrants({
      objectId: folder.value.id,
      changes: [
        { grant: { type: "deny", mode: 0o6 }, remove: false },
        {
          grant: {
            type: "allow",
            subject: createUserSubject(user),
            mode: 0o6,
          },
          remove: false,
        },
      ],
    });
    if (granted.isErr()) {
      return granted;
    }
  }
  const created = await DfsUserFolderResource.makeNew(auth, {
    user,
    dfsObjectId: folder.value.id,
  });
  return new Ok(created.dfsObjectId);
}

/**
 * The folder of the pod `space`, under the folder of `user`, or of its first editor when no user is
 * given (backfill).
 */
export async function getOrCreatePodFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  space: SpaceResource,
  { user }: { user?: UserResource } = {}
): Promise<Result<DfsObjectId, DfsError>> {
  if (!space.isProject()) {
    return new Err(new DfsError("invalid_input", "Only pods have a folder."));
  }
  if (space.dfsObjectId) {
    return new Ok(space.dfsObjectId);
  }
  const owner = user ?? (await getFirstEditor(auth, space));
  if (!owner) {
    return new Err(
      new DfsError("invalid_input", `Pod ${space.sId} has no editor.`)
    );
  }
  // TODO(dfs): grant access to every member of the pod.
  const userFolderId = await getOrCreateUserFolder(auth, context, owner);
  if (userFolderId.isErr()) {
    return userFolderId;
  }
  const folderId = await ensurePodFolder(context.fs, userFolderId.value, space);
  if (folderId.isErr()) {
    return folderId;
  }
  // A concurrent call may have stored another folder first: return the stored one.
  const stored = await space.setDfsObjectId(auth, folderId.value);
  if (!stored) {
    return new Err(
      new DfsError("not_found", `Pod ${space.sId} no longer exists.`)
    );
  }
  return new Ok(stored);
}

function realObjectId(id: string): Result<DfsObjectId, DfsError> {
  return isDfsObjectId(id)
    ? new Ok(id)
    : new Err(new DfsError("invalid_response", "Expected a real object."));
}

/**
 * @cc [owner:fabiencelier,label:security] pod-folder-owned
 * A pod folder MUST be created with the `dust.pod_id` xattr set to the pod's sId. An existing folder
 * MUST only be reused when its `dust.pod_id` is the pod's sId: a folder of another pod (e.g. a
 * deleted pod with the same name) MUST never be reused, and the next name of `podFolderNames` is
 * tried instead. When no name is available, the call MUST fail with `already_exists`.
 */
async function ensurePodFolder(
  fs: DfsFileSystem,
  userFolderId: DfsObjectId,
  space: SpaceResource
): Promise<Result<DfsObjectId, DfsError>> {
  for (const name of podFolderNames(space)) {
    const uri = podFolderUri(userFolderId, name);
    const made = await fs.mkdir(uri, {
      mimeType: DFS_POD_FOLDER_MIME_TYPE,
      xattrs: {
        [DFS_DISPLAY_NAME_XATTR]: Buffer.from(space.name, "utf8"),
        [DFS_POD_ID_XATTR]: Buffer.from(space.sId, "utf8"),
      },
    });
    if (made.isOk()) {
      return realObjectId(made.value.attr.id);
    }
    if (made.error.code !== "already_exists") {
      return made;
    }
    const existing = await fs.stat(uri, { includeMetadata: true });
    if (existing.isErr()) {
      return existing;
    }
    const podId = existing.value?.attr.metadata?.xattrs[DFS_POD_ID_XATTR];
    if (
      existing.value?.attr.kind === "directory" &&
      podId &&
      Buffer.from(podId).toString("utf8") === space.sId
    ) {
      return realObjectId(existing.value.attr.id);
    }
  }
  return new Err(
    new DfsError(
      "already_exists",
      `Every folder name of pod ${space.sId} is taken by another object.`
    )
  );
}

async function getFirstEditor(
  auth: Authenticator,
  space: SpaceResource
): Promise<UserResource | null> {
  const editors = await space.fetchActiveEditorUsers(auth);
  return editors.sort((a, b) => a.id - b.id)[0] ?? null;
}

/**
 * The folder of `conversation`: under its pod's folder for a conversation in a pod, else under the
 * folder of `user`, or of its first participant when no user is given (backfill).
 */
export async function getOrCreateConversationFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  conversation: ConversationResource,
  { user }: { user?: UserResource } = {}
): Promise<Result<DfsObjectId, DfsError>> {
  if (conversation.dfsObjectId) {
    return new Ok(conversation.dfsObjectId);
  }
  const parentId = await getOrCreateConversationParentFolder(
    auth,
    context,
    conversation,
    { user }
  );
  if (parentId.isErr()) {
    return parentId;
  }
  const folder = await ensureFolder(
    context.fs,
    conversationFolderUri(parentId.value, conversation.sId),
    { mimeType: DFS_CONVERSATION_FOLDER_MIME_TYPE }
  );
  if (folder.isErr()) {
    return folder;
  }
  // A concurrent call may have stored another folder first: return the stored one.
  const stored = await conversation.setDfsObjectId(auth, folder.value.id);
  if (!stored) {
    return new Err(
      new DfsError(
        "not_found",
        `Conversation ${conversation.sId} no longer exists.`
      )
    );
  }
  return new Ok(stored);
}

async function getOrCreateConversationParentFolder(
  auth: Authenticator,
  context: DfsFolderContext,
  conversation: ConversationResource,
  { user }: { user?: UserResource }
): Promise<Result<DfsObjectId, DfsError>> {
  if (conversation.spaceId) {
    const [space] = await SpaceResource.fetchByModelIds(auth, [
      conversation.spaceId,
    ]);
    if (space?.isProject()) {
      return getOrCreatePodFolder(auth, context, space, { user });
    }
  }
  const owner = user ?? (await getFirstParticipant(auth, conversation));
  if (!owner) {
    return new Err(
      new DfsError(
        "invalid_input",
        `Conversation ${conversation.sId} has no participant.`
      )
    );
  }
  return getOrCreateUserFolder(auth, context, owner);
}

async function getFirstParticipant(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<UserResource | null> {
  const [first] = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  return first ? UserResource.fetchByModelId(first.userId) : null;
}
