import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { getOrCreateUserFolder } from "@app/lib/api/dfs/folders";
import { importGcsFile } from "@app/lib/api/dfs/gcs_import/file";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import type { Authenticator } from "@app/lib/auth";
import type { DfsFileSystemClient } from "@app/lib/dfs/file_system";
import type { DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

interface GcsUserImportContext {
  // Both clients must belong to the authenticated workspace's tenant.
  folders: DfsFolderContext;
  // A session for the authenticated user, created with createDfsSession.
  client: DfsFileSystemClient;
  signal?: AbortSignal;
}

/**
 * @cc [owner:flvndvd,label:security] gcs-import-destination
 * Only import the authenticated workspace member's users/<userId>/files/ objects. Reuse
 * getOrCreateUserFolder and preserve relative paths.
 */
export async function importGcsUserFile(
  auth: Authenticator,
  source: GcsReplicationSource,
  { folders, client, signal }: GcsUserImportContext
): Promise<Result<DfsObjectId, Error>> {
  const pathRes = parseGcsReplicationPath(source.objectName);
  if (pathRes.isErr()) {
    return pathRes;
  }

  const path = pathRes.value;
  const user = auth.user();
  if (
    !path ||
    path.kind !== "user" ||
    !user ||
    !auth.isUser() ||
    path.resourceId !== user.sId ||
    path.workspaceId !== source.workspaceId ||
    source.workspaceId !== auth.getNonNullableWorkspace().sId
  ) {
    return new Err(new Error("Invalid GCS source for this workspace."));
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
    const folderRes = await getOrCreateUserFolder(auth, folders, user);
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
