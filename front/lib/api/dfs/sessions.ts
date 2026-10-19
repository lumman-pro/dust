import type { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import type { UserResource } from "@app/lib/resources/user_resource";
import type { DfsSession } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

// See `CreateSession` in `dfs/design-docs/API.md`.
const MAX_SESSION_SUBJECTS = 512;

// Reserved subject that gets `rw` on every object of its session's tenant, ignoring all grants (see
// `superuser` in `dfs/design-docs/API.md`).
export const DFS_SUPERUSER_SUBJECT = "superuser";

export function createUserSubject(user: UserResource): string {
  return `u:${user.sId}`;
}

export function createGroupSubject(groupId: string): string {
  return `g:${groupId}`;
}

/**
 * @cc [owner:fabiencelier,label:security] subjects-from-auth
 * The subjects MUST be `u:<userSId>` for the authenticated user, if any, and `g:<groupSId>` for each
 * group of `auth.listGroupIds()`, and nothing else. An authenticator without a user (e.g. an API
 * key) MUST get no `u:` subject.
 */
export async function getDfsSessionSubjects(
  auth: Authenticator
): Promise<string[]> {
  const user = auth.user();
  const groupIds = await auth.listGroupIds();
  return [
    ...(user ? [createUserSubject(user)] : []),
    ...groupIds.map(createGroupSubject),
  ];
}

/**
 * Creates a dfs session holding the subjects of `auth` (see `getDfsSessionSubjects`) and returns it
 * with a client authenticated with its session key. `tenantClient` MUST be authenticated with the
 * tenant key of the authenticated workspace (see `getDfsTenantClient`).
 */
/**
 * @cc [owner:fabiencelier,label:security] session-in-workspace-tenant
 * The session MUST belong to the workspace's tenant: a session whose `tenantId` is not the
 * workspace sId MUST fail with `invalid_response`. More subjects than dfs accepts MUST fail with
 * `invalid_input` without calling dfs.
 */
export async function createDfsSession(
  auth: Authenticator,
  { tenantClient }: { tenantClient: DfsClient }
): Promise<
  Result<{ session: DfsSession; sessionClient: DfsClient }, DfsError>
> {
  const subjects = await getDfsSessionSubjects(auth);
  if (subjects.length > MAX_SESSION_SUBJECTS) {
    return new Err(
      new DfsError(
        "invalid_input",
        `Too many dfs session subjects: ${subjects.length}.`
      )
    );
  }
  return openSession(auth, { tenantClient, subjects });
}

/**
 * Creates a dfs session holding only `DFS_SUPERUSER_SUBJECT`, which bypasses all grants in the
 * authenticated workspace's tenant, and returns it with a client authenticated with its session
 * key. `tenantClient` MUST be authenticated with the tenant key of the authenticated workspace (see
 * `getDfsTenantClient`).
 */
/**
 * @cc [owner:fabiencelier,label:security] superuser-session-subjects
 * The session MUST hold `DFS_SUPERUSER_SUBJECT` and no other subject, and MUST belong to the
 * workspace's tenant: a session whose `tenantId` is not the workspace sId MUST fail with
 * `invalid_response`.
 */
/**
 * @cc [owner:fabiencelier;id13,notify:fabiencelier;id13,label:security] superuser-session-uses
 * The returned session can read and write every file and folder of the workspace in dfs, whatever
 * their permissions, so it MUST only be used to create the context folders of
 * `dfs/design-docs/URI.md`, with their MIME type and xattrs:
 * - `users/` and the user folders `users/<userSId>`;
 * - `pods/` and the pod folders `pods/<podName>`.
 *
 * It MUST NOT read, write, move or remove any other object, nor be given to a user, an agent or a
 * sandbox. Any other access MUST use a session from `createDfsSession`.
 */
export async function createDfsSuperuserSession(
  auth: Authenticator,
  { tenantClient }: { tenantClient: DfsClient }
): Promise<
  Result<{ session: DfsSession; sessionClient: DfsClient }, DfsError>
> {
  return openSession(auth, { tenantClient, subjects: [DFS_SUPERUSER_SUBJECT] });
}

async function openSession(
  auth: Authenticator,
  { tenantClient, subjects }: { tenantClient: DfsClient; subjects: string[] }
): Promise<
  Result<{ session: DfsSession; sessionClient: DfsClient }, DfsError>
> {
  const session = await tenantClient.createSession({ subjects });
  if (session.isErr()) {
    return session;
  }
  if (session.value.tenantId !== auth.getNonNullableWorkspace().sId) {
    return new Err(
      new DfsError(
        "invalid_response",
        "Dfs created a session in another tenant."
      )
    );
  }
  return new Ok({
    session: session.value,
    sessionClient: tenantClient.withKey(session.value.sessionKey),
  });
}
