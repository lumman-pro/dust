import { withDfsFolderContext } from "@app/lib/api/dfs/folder_context";
import {
  getOrCreatePodFolder,
  getPodFolderGrants,
} from "@app/lib/api/dfs/folders";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import type { UserResource } from "@app/lib/resources/user_resource";
import logger from "@app/logger/logger";
import type { DfsGrant, DfsGrantUpdate, DfsObjectId } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";

// See `ListGrants` in `dfs/design-docs/API.md`.
const LIST_GRANTS_LIMIT = 512;

function grantKey(grant: DfsGrant): string {
  return grant.type === "allow"
    ? `allow:${grant.subject}:${grant.mode}`
    : `deny:${grant.mode}`;
}

async function listAllGrants(
  tenantClient: DfsClient,
  objectId: DfsObjectId
): Promise<Result<DfsGrant[], Error>> {
  const grants: DfsGrant[] = [];
  let after: string | undefined;
  do {
    const page = await tenantClient.listGrants({
      objectId,
      after,
      limit: LIST_GRANTS_LIMIT,
    });
    if (page.isErr()) {
      return page;
    }
    grants.push(...page.value.grants);
    after = page.value.nextAfter;
  } while (after !== undefined);
  return new Ok(grants);
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
    listAllGrants(tenantClient, folderId),
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

/**
 * Creates the dfs folder of the pod `space` if missing, under the folder of `user` (see
 * `getOrCreatePodFolder`), and makes its grants match the pod's current access (see
 * `syncPodFolderGrants`). Spaces that are not pods are left alone.
 */
export async function syncDfsPodFolder(
  auth: Authenticator,
  space: SpaceResource,
  { user }: { user?: UserResource } = {}
): Promise<Result<void, Error>> {
  if (!space.isProject()) {
    return new Ok(undefined);
  }
  return withDfsFolderContext(auth, async (context) => {
    const folderId = await getOrCreatePodFolder(auth, context, space, {
      user,
    });
    if (folderId.isErr()) {
      return folderId;
    }
    return syncPodFolderGrants(context.tenantClient, folderId.value, space);
  });
}

/**
 * Reflects the pod `space` on dfs when the workspace has the `dust_file_system` feature flag (see
 * `syncDfsPodFolder`). Called after a pod is created or its access changes; a failure is logged and
 * never fails the caller.
 */
export async function reflectPodOnDfs(
  auth: Authenticator,
  space: SpaceResource,
  { user }: { user?: UserResource } = {}
): Promise<void> {
  if (!space.isProject() || !(await hasFeatureFlag(auth, "dust_file_system"))) {
    return;
  }
  try {
    const synced = await syncDfsPodFolder(auth, space, { user });
    if (synced.isErr()) {
      logger.error(
        {
          workspaceId: auth.getNonNullableWorkspace().sId,
          spaceId: space.sId,
          err: synced.error,
        },
        "Failed to reflect a pod on dfs."
      );
    }
  } catch (err) {
    logger.error(
      {
        workspaceId: auth.getNonNullableWorkspace().sId,
        spaceId: space.sId,
        err,
      },
      "Failed to reflect a pod on dfs."
    );
  }
}
