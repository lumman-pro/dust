import { Authenticator } from "@app/lib/auth";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { assertNever } from "@app/types/shared/utils/assert_never";
import assert from "assert";

// `w/<workspaceSId>/pods/<podSId>/files/<path>`, see `getPodFilesBasePath`.
const POD_FILE_OBJECT_NAME_REGEX = /^w\/([^/]+)\/pods\/([^/]+)\/files\/(.+)$/;
// Custom metadata key holding a symlink's target on the empty object gcsfuse stores for it.
const GCSFUSE_SYMLINK_TARGET_METADATA_KEY = "gcsfuse_symlink_target";
// The folder of a pod's dfs folder holding its files, see `dfs/design-docs/URI.md`.
const DFS_FILES_FOLDER_NAME = "files";

/** An object of the private uploads bucket that dfs mirrors. */
export type ReplicatedGcsObject = {
  kind: "pod_file";
  objectName: string;
  workspaceId: string;
  podId: string;
  // The object name below the pod's files root, ending with `/` for a folder placeholder.
  path: string;
};

/** The dfs folder of a pod, which front creates and stores on the pod. */
export type DfsReplicationFolder = { kind: "pod"; podId: string };

/** A path below the dfs folder of a pod. */
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
 * Only object names `w/<workspaceSId>/pods/<podSId>/files/<path>` with a non-empty `<path>` MUST be
 * parsed. Every other name MUST return `null`: it is not replicated.
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
 * Names `parseReplicatedGcsObjectName` rejects, objects of a workspace without a dfs tenant, and
 * files of a pod that does not exist (including a soft-deleted one) MUST be planned as `skip`.
 */
/**
 * @cc [owner:aubin-tchoi,label:product] files-folder-targets
 * Target paths MUST start with `files`: pod files live under `files/` in the pod's dfs folder, as in
 * `dfs/design-docs/URI.md`, never at its root.
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
    default:
      assertNever(object.kind);
  }
}

async function planMirror(
  { objectName, path }: ReplicatedGcsObject,
  folder: DfsReplicationFolder
): Promise<DfsReplicationPlan> {
  const isFolder = path.endsWith("/");
  const target: DfsReplicationTarget = {
    folder,
    path: [
      DFS_FILES_FOLDER_NAME,
      ...(isFolder ? path.slice(0, -1) : path).split("/"),
    ],
  };

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
