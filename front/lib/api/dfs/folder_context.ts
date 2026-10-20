import {
  getDfsMasterClient,
  getDfsTenantClient,
} from "@app/lib/api/dfs/clients";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import { createDfsSuperuserSession } from "@app/lib/api/dfs/sessions";
import { createDfsTenant } from "@app/lib/api/dfs/tenants";
import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import logger from "@app/logger/logger";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";

/** The dfs tenant of the authenticated workspace, created if it has none. */
async function getOrCreateDfsTenant(
  auth: Authenticator
): Promise<Result<DfsTenantResource, Error>> {
  const existing = await DfsTenantResource.fetchByWorkspace(auth);
  if (existing) {
    return new Ok(existing);
  }
  const created = await createDfsTenant(auth, {
    masterClient: getDfsMasterClient(),
  });
  if (created.isErr()) {
    // A concurrent call may have created and stored it first.
    const stored = await DfsTenantResource.fetchByWorkspace(auth);
    return stored ? new Ok(stored) : created;
  }
  return created;
}

/**
 * Runs `fn` with the folder context of the authenticated workspace, creating its dfs tenant if
 * needed. The context's file system uses a superuser session, revoked once `fn` returns.
 */
/**
 * @cc [owner:fabiencelier,label:security] folder-context-superuser-session
 * The superuser session MUST only be exposed through the context's `fs`, which `fn` MUST only use as
 * `superuser-session-uses` allows, and MUST be revoked once `fn` settles, whether it succeeds,
 * fails or throws.
 */
export async function withDfsFolderContext<T>(
  auth: Authenticator,
  fn: (
    context: DfsFolderContext & { tenantClient: DfsClient }
  ) => Promise<Result<T, Error>>
): Promise<Result<T, Error>> {
  const tenant = await getOrCreateDfsTenant(auth);
  if (tenant.isErr()) {
    return tenant;
  }
  const tenantClient = await getDfsTenantClient(auth);
  if (tenantClient.isErr()) {
    return tenantClient;
  }
  const superuser = await createDfsSuperuserSession(auth, {
    tenantClient: tenantClient.value,
  });
  if (superuser.isErr()) {
    return superuser;
  }
  try {
    return await fn({
      fs: new DfsFileSystem(superuser.value.sessionClient),
      tenantClient: tenantClient.value,
      rootId: tenant.value.rootId,
    });
  } finally {
    const revoked = await tenantClient.value.revokeSession({
      sessionId: superuser.value.session.id,
    });
    if (revoked.isErr()) {
      logger.error(
        {
          workspaceId: auth.getNonNullableWorkspace().sId,
          err: revoked.error,
        },
        "Failed to revoke a dfs superuser session."
      );
    }
  }
}
