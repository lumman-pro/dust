import {
  getDfsMasterClient,
  getDfsTenantClient,
} from "@app/lib/api/dfs/clients";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import {
  createDfsSession,
  createDfsSuperuserSession,
} from "@app/lib/api/dfs/sessions";
import { createDfsTenant } from "@app/lib/api/dfs/tenants";
import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import logger from "@app/logger/logger";
import type { DfsSession } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

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

async function revokeSession(
  auth: Authenticator,
  tenantClient: DfsClient,
  session: DfsSession
): Promise<void> {
  const revoked = await tenantClient.revokeSession({ sessionId: session.id });
  if (revoked.isErr()) {
    logger.error(
      { workspaceId: auth.getNonNullableWorkspace().sId, err: revoked.error },
      "Failed to revoke a dfs session."
    );
  }
}

type OpenedSession = Result<
  { session: DfsSession; sessionClient: DfsClient },
  DfsError
>;

/** Runs `fn` with a file system on `opened`, then revokes the session. */
async function withSession<T>(
  auth: Authenticator,
  tenantClient: DfsClient,
  opened: OpenedSession,
  fn: (fs: DfsFileSystem) => Promise<Result<T, Error>>
): Promise<Result<T, Error>> {
  if (opened.isErr()) {
    return opened;
  }
  try {
    return await fn(new DfsFileSystem(opened.value.sessionClient));
  } finally {
    await revokeSession(auth, tenantClient, opened.value.session);
  }
}

/**
 * Runs `fn` with a file system on a superuser session of the authenticated workspace's tenant,
 * revoked once `fn` settles. `tenantClient` MUST be authenticated with the workspace's tenant key.
 */
/**
 * @cc [owner:fabiencelier,label:security] superuser-session-revoked
 * The superuser session MUST only be exposed through the file system given to `fn`, which `fn`
 * MUST only use as `superuser-session-uses` allows, and MUST be revoked once `fn` settles, whether
 * it succeeds, fails or throws.
 */
export async function withDfsSuperuserFileSystem<T>(
  auth: Authenticator,
  tenantClient: DfsClient,
  fn: (fs: DfsFileSystem) => Promise<Result<T, Error>>
): Promise<Result<T, Error>> {
  return withSession(
    auth,
    tenantClient,
    await createDfsSuperuserSession(auth, { tenantClient }),
    fn
  );
}

/**
 * Runs `fn` with the folder context of the authenticated user, creating the workspace's dfs tenant
 * if needed. The context's `fs` is a session of the user (see `createDfsSession`). Its superuser
 * file system, needed to create a missing user folder, is only available with `allowSuperuser`,
 * and only opened if `fn` asks for it.
 */
/**
 * @cc [owner:fabiencelier,label:security] folder-context-sessions
 * `fs` MUST be a session holding the subjects of `auth`, not a superuser session. Without
 * `allowSuperuser`, `getSuperuserFs` MUST fail with `forbidden` and open no session. With it, a
 * superuser session MUST only be opened when `getSuperuserFs` is called, and MUST only be used to
 * create user folders (see `superuser-session-uses`). Every session opened here MUST be revoked once
 * `fn` settles, whether it succeeds, fails or throws.
 */
export async function withDfsFolderContext<T>(
  auth: Authenticator,
  { allowSuperuser }: { allowSuperuser: boolean },
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
  const client = tenantClient.value;
  // Opened on the first `getSuperuserFs` call.
  const superuser: { opened: Promise<OpenedSession> | null } = {
    opened: null,
  };
  const getSuperuserFs = async (): Promise<Result<DfsFileSystem, DfsError>> => {
    if (!allowSuperuser) {
      return new Err(
        new DfsError(
          "forbidden",
          "This folder context does not allow superuser sessions."
        )
      );
    }
    superuser.opened ??= createDfsSuperuserSession(auth, {
      tenantClient: client,
    });
    const opened = await superuser.opened;
    return opened.isErr()
      ? opened
      : new Ok(new DfsFileSystem(opened.value.sessionClient));
  };
  try {
    return await withSession(
      auth,
      client,
      await createDfsSession(auth, { tenantClient: client }),
      (fs) =>
        fn({
          fs,
          getSuperuserFs,
          tenantClient: client,
          rootId: tenant.value.rootId,
        })
    );
  } finally {
    const opened = superuser.opened ? await superuser.opened : null;
    if (opened?.isOk()) {
      await revokeSession(auth, client, opened.value.session);
    }
  }
}
