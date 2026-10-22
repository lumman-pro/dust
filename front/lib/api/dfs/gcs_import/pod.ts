import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { getOrCreatePodFolder } from "@app/lib/api/dfs/folders";
import { importGcsFile } from "@app/lib/api/dfs/gcs_import/file";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import type { Authenticator } from "@app/lib/auth";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import { SpaceResource } from "@app/lib/resources/space_resource";
import type { DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

interface GcsPodImportContext {
  // Both clients must belong to the authenticated workspace's tenant.
  folders: DfsFolderContext;
  // A regular session for auth, created with createDfsSession.
  client: DfsFileSystemClient;
  signal?: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:security] gcs-pod-import-access
 * Only import pods/<podId>/files/ objects from the authenticated workspace. The pod MUST exist
 * and the caller MUST have write access before any GCS read or DFS mutation.
 */
/**
 * @cc [owner:flvndvd,label:product] gcs-pod-import-folder
 * Reuse getOrCreatePodFolder, including its stored folder ID and first-editor fallback. Preserve
 * the relative path without decoding or normalizing its components.
 */
export async function importGcsPodFile(
  auth: Authenticator,
  source: GcsReplicationSource,
  { folders, client, signal }: GcsPodImportContext
): Promise<Result<DfsObjectId, Error>> {
  const pathRes = parseGcsReplicationPath(source.objectName);
  if (pathRes.isErr()) {
    return pathRes;
  }

  const path = pathRes.value;
  if (
    !path ||
    path.kind !== "pod" ||
    path.workspaceId !== source.workspaceId ||
    source.workspaceId !== auth.getNonNullableWorkspace().sId
  ) {
    return new Err(new Error("Invalid GCS source for this workspace."));
  }

  const pod = await SpaceResource.fetchById(auth, path.resourceId);
  if (!pod || !pod.isProject()) {
    return new Err(new Error("Source pod not found."));
  }
  if (!auth.can("write", pod)) {
    return new Err(new Error("Cannot import files into this pod."));
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
    const folderRes = await getOrCreatePodFolder(auth, folders, pod);
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
