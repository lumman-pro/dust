import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import {
  getOrCreatePodFolder,
  getPodFolderGrants,
} from "@app/lib/api/dfs/folders";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import logger from "@app/logger/logger";
import type { DfsGrant, DfsGrantUpdate, DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";

function grantKey(grant: DfsGrant): string {
  return grant.type === "allow"
    ? `allow:${grant.subject}:${grant.mode}`
    : `deny:${grant.mode}`;
}

/**
 * Makes the grants attached to the pod folder `folderId` match `getPodFolderGrants(space)`.
 * `tenantClient` MUST be authenticated with the tenant key of the authenticated workspace.
 */
/**
 * @cc [owner:fabiencelier,label:security] pod-folder-grants-sync
 * After a successful call, the grants attached to the pod folder MUST be exactly
 * `getPodFolderGrants(space)`: missing grants are attached and every other grant is detached, in a
 * single `UpdateGrants` call, or none when nothing differs.
 */
export async function syncPodFolderGrants(
  tenantClient: DfsClient,
  folderId: DfsObjectId,
  space: SpaceResource
): Promise<Result<void, Error>> {
  const [current, desired] = await Promise.all([
    tenantClient.listAllGrants({ objectId: folderId }),
    getPodFolderGrants(space),
  ]);
  if (current.isErr()) {
    return current;
  }
  const currentKeys = new Set(current.value.map(grantKey));
  const desiredKeys = new Set(desired.map(grantKey));
  const changes: DfsGrantUpdate[] = [
    ...desired
      .filter((grant) => !currentKeys.has(grantKey(grant)))
      .map((grant) => ({ grant, remove: false })),
    ...current.value
      .filter((grant) => !desiredKeys.has(grantKey(grant)))
      .map((grant) => ({ grant, remove: true })),
  ];
  if (changes.length === 0) {
    return new Ok(undefined);
  }
  return tenantClient.updateGrants({ objectId: folderId, changes });
}

async function isReflectedOnDfs(
  auth: Authenticator,
  space: SpaceResource
): Promise<boolean> {
  return space.isProject() && (await hasFeatureFlag(auth, "dust_file_system"));
}

/**
 * Creates the dfs folder of the pod `space` just created by the authenticated user, under that
 * user's folder and with that user's session, when the workspace has the `dust_file_system` feature
 * flag. Without a user (e.g. a pod provisioned by the system), nothing is created. A dfs failure
 * is logged and does not fail the caller.
 */
export async function reflectPodCreationOnDfs(
  auth: Authenticator,
  space: SpaceResource
): Promise<void> {
  const user = auth.user();
  if (!user || !(await isReflectedOnDfs(auth, space))) {
    return;
  }
  // The superuser session only creates the creator's user folder if it is missing.
  const created = await withDfsFolderContext(
    auth,
    { allowSuperuser: true },
    async (context) => getOrCreatePodFolder(auth, context, space, { user })
  );
  if (created.isErr()) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        spaceId: space.sId,
        err: created.error,
      },
      "Failed to create a pod folder on dfs."
    );
  }
}

/**
 * Makes the grants of the pod folder of `space` match the pod's current access, with the tenant
 * key, when the workspace has the `dust_file_system` feature flag (see `syncPodFolderGrants`). A
 * pod without a folder is left alone: no folder is created. A dfs failure is logged and does not
 * fail the caller.
 */
export async function reflectPodPermissionsOnDfs(
  auth: Authenticator,
  space: SpaceResource
): Promise<void> {
  const folderId = space.dfsObjectId;
  if (!folderId || !(await isReflectedOnDfs(auth, space))) {
    return;
  }
  const tenantClient = await getDfsTenantClient(auth);
  const synced = tenantClient.isErr()
    ? tenantClient
    : await syncPodFolderGrants(tenantClient.value, folderId, space);
  if (synced.isErr()) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        spaceId: space.sId,
        err: synced.error,
      },
      "Failed to sync pod folder grants on dfs."
    );
  }
}
