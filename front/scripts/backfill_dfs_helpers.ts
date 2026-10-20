import assert from "node:assert";
import { getDfsTenantClient } from "@app/lib/api/dfs/clients";
import type { DfsFolderContext } from "@app/lib/api/dfs/folders";
import {
  createDfsSession,
  createDfsSuperuserSession,
} from "@app/lib/api/dfs/sessions";
import { Authenticator } from "@app/lib/auth";
import type { DfsClient } from "@app/lib/dfs/client";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { getPrivateUploadBucket } from "@app/lib/file_storage";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { DfsTenantResource } from "@app/lib/resources/dfs_tenant_resource";
import type { FileResource } from "@app/lib/resources/file_resource";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import { UserResource } from "@app/lib/resources/user_resource";
import type { DfsObjectId } from "@app/types/dfs";
import { DfsError, isDfsObjectId } from "@app/types/dfs";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export interface DfsBackfillTenant {
  tenantClient: DfsClient;
  rootId: DfsObjectId;
}

/** The dfs tenant of the authenticated workspace, or null when it has none. */
export async function getDfsBackfillTenant(
  auth: Authenticator
): Promise<DfsBackfillTenant | null> {
  const tenant = await DfsTenantResource.fetchByWorkspace(auth);
  if (!tenant) {
    return null;
  }
  const tenantClient = await getDfsTenantClient(auth);
  if (tenantClient.isErr()) {
    throw tenantClient.error;
  }
  return { tenantClient: tenantClient.value, rootId: tenant.rootId };
}

/**
 * A folder context on a superuser session. Per `superuser-session-uses`, it MUST only be passed to
 * `getOrCreateUserFolder` and `getOrCreatePodFolder`. Sessions expire after one hour: create one
 * per batch.
 */
export async function getSuperuserFolderContext(
  auth: Authenticator,
  { tenantClient, rootId }: DfsBackfillTenant
): Promise<DfsFolderContext> {
  const session = await createDfsSuperuserSession(auth, { tenantClient });
  if (session.isErr()) {
    throw session.error;
  }
  return {
    fs: new DfsFileSystem(session.value.sessionClient),
    tenantClient,
    rootId,
  };
}

/**
 * Returns a folder context on a session of each user, to create conversation folders and write
 * files under a folder that user owns. Creates one session per user: sessions expire after one
 * hour, so use one getter per batch.
 */
export function makeUserFolderContextGetter(
  auth: Authenticator,
  { tenantClient, rootId }: DfsBackfillTenant
): (user: UserResource) => Promise<DfsFolderContext> {
  const contexts = new Map<ModelId, Promise<DfsFolderContext>>();
  const create = async (user: UserResource): Promise<DfsFolderContext> => {
    const userAuth = await Authenticator.fromUserIdAndWorkspaceId(
      user.sId,
      auth.getNonNullableWorkspace().sId
    );
    const session = await createDfsSession(userAuth, { tenantClient });
    if (session.isErr()) {
      throw session.error;
    }
    return {
      fs: new DfsFileSystem(session.value.sessionClient),
      tenantClient,
      rootId,
    };
  };
  return (user) => {
    const context = contexts.get(user.id) ?? create(user);
    contexts.set(user.id, context);
    return context;
  };
}

// Same owner choices as the backfill defaults of `@app/lib/api/dfs/folders`. Scripts pass the owner
// explicitly so that the folders and the session writing into them belong to the same user.
export async function getFirstEditor(
  auth: Authenticator,
  space: SpaceResource
): Promise<UserResource | null> {
  const editors = await space.fetchActiveEditorUsers(auth);
  return editors.sort((a, b) => a.id - b.id)[0] ?? null;
}

export async function getFirstParticipant(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<UserResource | null> {
  const [first] = await ConversationResource.listParticipantDetails(
    auth,
    conversation
  );
  return first ? UserResource.fetchByModelId(first.userId) : null;
}

/**
 * Writes the GCS mount copy of `file` under the folder `folderId`, at its mount path relative to
 * `basePath`, replacing any file already there, then stores the written object's ID on `file`.
 * Returns the stored ID, null if the file no longer exists.
 */
export async function writeMountFileToDfs(
  auth: Authenticator,
  {
    fs,
    folderId,
    basePath,
    file,
  }: {
    fs: DfsFileSystem;
    folderId: DfsObjectId;
    basePath: string;
    file: FileResource;
  }
): Promise<Result<DfsObjectId | null, DfsError>> {
  const { mountFilePath } = file;
  assert(
    mountFilePath && mountFilePath.startsWith(basePath),
    "File must be mounted under the base path."
  );
  const written = await fs.write(
    formatDfsUri(folderId, {
      path: mountFilePath.slice(basePath.length).split("/"),
    }),
    getPrivateUploadBucket().file(mountFilePath).createReadStream(),
    { mimeType: file.contentType }
  );
  if (written.isErr()) {
    return written;
  }
  const { id } = written.value.attr;
  if (!isDfsObjectId(id)) {
    return new Err(new DfsError("invalid_response", "Expected a real object."));
  }
  return new Ok(await file.setDfsObjectId(auth, id));
}
