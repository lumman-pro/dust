import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import type { GcsReplicationSource } from "@app/lib/api/dfs/gcs_notifications";
import { parseGcsReplicationPath } from "@app/lib/api/dfs/gcs_notifications";
import { createDfsSession } from "@app/lib/api/dfs/sessions";
import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import logger from "@app/logger/logger";
import { getBaseMountPathForWorkspace } from "@app/types/mount_path";
import type { Result } from "@app/types/shared/result";

export interface DfsBackfillCounts {
  imported: number;
  failed: number;
  skipped: number;
}

/**
 * Runs `fn` with the `folders` and `client` contexts of the GCS importers for the authenticated
 * user. `folders` comes from `withDfsFolderContext`, with the superuser session allowed to create a
 * missing user folder. `client` is another session of the user, since the importers write files
 * through the raw client. Both sessions are revoked once `fn` settles.
 */
export async function withGcsImportContext<T>(
  auth: Authenticator,
  fn: (context: {
    folders: DfsFolderContext;
    client: DfsClient;
  }) => Promise<Result<T, Error>>
): Promise<Result<T, Error>> {
  return withDfsFolderContext(
    auth,
    { allowSuperuser: true },
    async (folders) => {
      const session = await createDfsSession(auth, {
        tenantClient: folders.tenantClient,
      });
      if (session.isErr()) {
        return session;
      }
      try {
        return await fn({ folders, client: session.value.sessionClient });
      } finally {
        const revoked = await folders.tenantClient.revokeSession({
          sessionId: session.value.session.id,
        });
        if (revoked.isErr()) {
          logger.error(
            {
              workspaceId: auth.getNonNullableWorkspace().sId,
              err: revoked.error,
            },
            "Failed to revoke a dfs session."
          );
        }
      }
    }
  );
}

/** The IDs of the pods or users that have a folder in GCS (`w/<workspaceId>/<namespace>/<id>/`). */
export async function listGcsResourceIds(
  workspaceId: string,
  namespace: "pods" | "users"
): Promise<string[]> {
  return getPrivateUploadBucket().listSubdirectoryNames({
    prefix: `${getBaseMountPathForWorkspace({ workspaceId })}${namespace}/`,
  });
}

/**
 * The objects under the `files/` folder of a pod or user in GCS, without the ones the importers
 * ignore (directory markers).
 */
export async function listGcsReplicationSources(
  workspaceId: string,
  namespace: "pods" | "users",
  resourceId: string
): Promise<GcsReplicationSource[]> {
  const bucket = getPrivateUploadBucket();
  const { files } = await bucket.getAllFilesByPrefix({
    prefix: `${getBaseMountPathForWorkspace({ workspaceId })}${namespace}/${resourceId}/files/`,
  });
  return files
    .filter((file) => {
      const path = parseGcsReplicationPath(file.name);
      // Invalid paths are kept, for the importers to reject.
      return path.isErr() || path.value !== null;
    })
    .map((file) => ({
      workspaceId,
      bucket: bucket.name,
      objectName: file.name,
    }));
}
