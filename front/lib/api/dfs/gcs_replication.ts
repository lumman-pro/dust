import { Authenticator } from "@app/lib/auth";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import { MembershipResource } from "@app/lib/resources/membership_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import { assertNever } from "@app/types/shared/utils/assert_never";
import assert from "assert";

// `w/<workspaceId>/pods/<podId>/files/<path>`, see `getPodFilesBasePath`.
const POD_FILE_OBJECT_NAME_REGEX = /^w\/([^/]+)\/pods\/([^/]+)\/files\/(.+)$/;
// `w/<workspaceId>/conversations/<conversationId>/files/<path>`, see
// `getConversationFilesBasePath`.
const CONVERSATION_FILE_OBJECT_NAME_REGEX =
  /^w\/([^/]+)\/conversations\/([^/]+)\/files\/(.+)$/;
// `w/<workspaceId>/conversations/<conversationId>/MEMORY.md`, see `ensureConversationMemoryFile`.
const CONVERSATION_MEMORY_FILE_OBJECT_NAME_REGEX =
  /^w\/([^/]+)\/conversations\/([^/]+)\/MEMORY\.md$/;
// `w/<workspaceId>/users/<userId>/files/<path>`, see `GCSFileSystemBackend.toGCSPath`.
const USER_FILE_OBJECT_NAME_REGEX = /^w\/([^/]+)\/users\/([^/]+)\/files\/(.+)$/;
// Custom metadata key holding a symlink's target on the empty object gcsfuse stores for it.
const GCSFUSE_SYMLINK_TARGET_METADATA_KEY = "gcsfuse_symlink_target";
// The folder of a user's, pod's or conversation's dfs folder holding its files, see
// `dfs/design-docs/URI.md`.
const DFS_FILES_FOLDER_NAME = "files";
// The conversation's memory file, at the root of its dfs folder beside `files/`, see
// `dfs/design-docs/URI.md`.
const DFS_CONVERSATION_MEMORY_FILE_NAME = "MEMORY.md";

interface ReplicatedPodFile {
  kind: "pod_file";
  objectName: string;
  workspaceId: string;
  podId: string;
  // The object name below the pod's files root, ending with `/` for a folder placeholder.
  path: string;
}

interface ReplicatedConversationFile {
  kind: "conversation_file";
  objectName: string;
  workspaceId: string;
  conversationId: string;
  // The object name below the conversation's files root, ending with `/` for a folder placeholder.
  path: string;
}

interface ReplicatedConversationMemoryFile {
  kind: "conversation_memory_file";
  objectName: string;
  workspaceId: string;
  conversationId: string;
}

interface ReplicatedUserFile {
  kind: "user_file";
  objectName: string;
  workspaceId: string;
  userId: string;
  // The object name below the user's files root, ending with `/` for a folder placeholder.
  path: string;
}

/** An object of the private uploads bucket that dfs mirrors. */
export type ReplicatedGcsObject =
  | ReplicatedPodFile
  | ReplicatedConversationFile
  | ReplicatedConversationMemoryFile
  | ReplicatedUserFile;

/** The dfs folder of a user, pod or conversation, which front creates and stores on it. */
export type DfsReplicationFolder =
  | { kind: "user"; userId: string }
  | { kind: "pod"; podId: string }
  | { kind: "conversation"; conversationId: string };

/** A path below the dfs folder of a user, pod or conversation. */
export interface DfsReplicationTarget {
  folder: DfsReplicationFolder;
  path: string[];
}

/** What replicating one GCS object does in dfs. */
export type DfsReplicationPlan =
  | {
      action: "skip";
      reason: "not_replicated" | "no_dfs_tenant" | "folder_owner_not_found";
    }
  | {
      action: "write";
      target: DfsReplicationTarget;
      objectName: string;
      // The GCS generation to copy, so the content matches the planned content type.
      generation: string;
      contentType?: string;
    }
  | { action: "mkdir"; target: DfsReplicationTarget }
  | { action: "remove"; target: DfsReplicationTarget };

/**
 * @cc [owner:aubin-tchoi,label:product] replicated-gcs-object-names
 * Only object names `w/<workspaceId>/pods/<podId>/files/<path>`,
 * `w/<workspaceId>/conversations/<conversationId>/files/<path>` and
 * `w/<workspaceId>/users/<userId>/files/<path>` with a non-empty `<path>`, and
 * `w/<workspaceId>/conversations/<conversationId>/MEMORY.md`, MUST be parsed. Every other name
 * MUST return `null`: it is not replicated.
 */
export function parseReplicatedGcsObjectName(
  objectName: string
): ReplicatedGcsObject | null {
  const podFile = objectName.match(POD_FILE_OBJECT_NAME_REGEX);
  if (podFile) {
    return {
      kind: "pod_file",
      objectName,
      workspaceId: podFile[1],
      podId: podFile[2],
      path: podFile[3],
    };
  }
  const conversationFile = objectName.match(
    CONVERSATION_FILE_OBJECT_NAME_REGEX
  );
  if (conversationFile) {
    return {
      kind: "conversation_file",
      objectName,
      workspaceId: conversationFile[1],
      conversationId: conversationFile[2],
      path: conversationFile[3],
    };
  }
  const conversationMemoryFile = objectName.match(
    CONVERSATION_MEMORY_FILE_OBJECT_NAME_REGEX
  );
  if (conversationMemoryFile) {
    return {
      kind: "conversation_memory_file",
      objectName,
      workspaceId: conversationMemoryFile[1],
      conversationId: conversationMemoryFile[2],
    };
  }
  const userFile = objectName.match(USER_FILE_OBJECT_NAME_REGEX);
  if (userFile) {
    return {
      kind: "user_file",
      objectName,
      workspaceId: userFile[1],
      userId: userFile[2],
      path: userFile[3],
    };
  }
  return null;
}

/**
 * Plans how dfs mirrors the private uploads bucket object `objectName` as it is now. Planning for
 * any event of the object yields the plan for its latest state. Nothing applies plans yet.
 */
/**
 * @cc [owner:aubin-tchoi,label:architecture] replication-plan-read-only
 * Planning MUST NOT write to dfs, GCS or the front database.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] plan-mirrors-live-object
 * The plan MUST reflect the object as read from GCS: an existing file is a `write` pinned to the
 * generation read, with its content type; an existing folder placeholder is a `mkdir`; a missing
 * object, or a gcsfuse symlink (an object with `gcsfuse_symlink_target` metadata, which dfs does not
 * support), is a `remove`.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] replication-skips
 * Names `parseReplicatedGcsObjectName` rejects, objects of a workspace without a dfs tenant, files
 * of a pod that does not exist (including a soft-deleted one), files and the memory file of a
 * conversation that does not exist (including a deleted one), and files of a user that does not
 * exist or is not an active member of the workspace MUST be planned as `skip`.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] files-folder-targets
 * Target paths of user, pod and conversation files MUST start with `files`: they live under
 * `files/` in their dfs folder, as in `dfs/design-docs/URI.md`, never at its root. The conversation
 * memory file is the only exception: its target path MUST be `MEMORY.md`, at the root of the
 * conversation's dfs folder beside `files/`.
 */
export async function planGcsObjectReplication(
  objectName: string
): Promise<DfsReplicationPlan> {
  const object = parseReplicatedGcsObjectName(objectName);
  if (!object) {
    return { action: "skip", reason: "not_replicated" };
  }
  const auth = await Authenticator.internalAdminForWorkspace(
    object.workspaceId
  );
  const tenant = await DfsTenantResource.fetchByWorkspace(auth);
  if (!tenant) {
    return { action: "skip", reason: "no_dfs_tenant" };
  }
  const folder = await getReplicationFolder(auth, object);
  if (!folder) {
    return { action: "skip", reason: "folder_owner_not_found" };
  }
  return planMirror(object, folder);
}

async function getReplicationFolder(
  auth: Authenticator,
  object: ReplicatedGcsObject
): Promise<DfsReplicationFolder | null> {
  switch (object.kind) {
    case "pod_file": {
      const space = await SpaceResource.fetchById(auth, object.podId);
      return space?.isProject() ? { kind: "pod", podId: space.sId } : null;
    }
    case "conversation_file":
    case "conversation_memory_file": {
      // Replication mirrors every conversation of the workspace, whoever can read it.
      const conversation = await ConversationResource.fetchById(
        auth,
        object.conversationId,
        { dangerouslySkipPermissionFiltering: true }
      );
      return conversation
        ? { kind: "conversation", conversationId: conversation.sId }
        : null;
    }
    case "user_file": {
      const user = await UserResource.fetchById(object.userId);
      if (!user) {
        return null;
      }
      const membership =
        await MembershipResource.getActiveMembershipOfUserInWorkspace({
          user,
          workspace: auth.getNonNullableWorkspace(),
        });
      return membership ? { kind: "user", userId: user.sId } : null;
    }
    default:
      assertNever(object);
  }
}

async function planMirror(
  object: ReplicatedGcsObject,
  folder: DfsReplicationFolder
): Promise<DfsReplicationPlan> {
  const { objectName } = object;
  const { path, isFolder } = getTargetPath(object);
  const target: DfsReplicationTarget = { folder, path };

  const file = getPrivateUploadBucket().file(objectName);
  const [exists] = await file.exists();
  if (!exists) {
    return { action: "remove", target };
  }
  const [metadata] = await file.getMetadata();
  if (metadata.metadata?.[GCSFUSE_SYMLINK_TARGET_METADATA_KEY] !== undefined) {
    return { action: "remove", target };
  }
  if (isFolder) {
    return { action: "mkdir", target };
  }
  const { generation } = metadata;
  assert(generation !== undefined, "GCS object metadata without generation.");
  return {
    action: "write",
    target,
    objectName,
    generation: String(generation),
    contentType: metadata.contentType,
  };
}

function getTargetPath(object: ReplicatedGcsObject): {
  path: string[];
  isFolder: boolean;
} {
  switch (object.kind) {
    case "pod_file":
    case "conversation_file":
    case "user_file": {
      const isFolder = object.path.endsWith("/");
      return {
        path: [
          DFS_FILES_FOLDER_NAME,
          ...(isFolder ? object.path.slice(0, -1) : object.path).split("/"),
        ],
        isFolder,
      };
    }
    case "conversation_memory_file":
      return { path: [DFS_CONVERSATION_MEMORY_FILE_NAME], isFolder: false };
    default:
      assertNever(object);
  }
}
