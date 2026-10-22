import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import { WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES } from "@app/lib/api/files/file_system_ops";
import type { WorkspaceAccessError } from "@app/lib/api/workspace_validation";
import { validateWorkspaceAccess } from "@app/lib/api/workspace_validation";
import type { Authenticator } from "@app/lib/auth";
import { hasFeatureFlag } from "@app/lib/auth";
import { isMarkdownContentType, stripMimeParameters } from "@app/types/files";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

/** A file the live session can open, with the caller's access to it. */
export interface CollabAccess {
  auth: Authenticator;
  workspaceId: string;
  canonicalPath: string;
  dustFs: DustFileSystem;
  canWrite: boolean;
}

/** Why a file cannot open in a live session. */
export interface CollabFileError {
  code:
    | "invalid_path"
    | "unavailable"
    | "not_markdown"
    | "too_large"
    | "unsupported_location";
  message: string;
}

/**
 * @cc [owner:PopDaph,label:security] collab-access-open
 * A live file MUST open only for a file that exists, whose stored type is Markdown by
 * `isMarkdownContentType` as for the browser's editor, and that `auth` can read through the file
 * system, with the same mount permissions as the file API, and only under its normalized path
 * without a trailing slash, so one file never has two live documents. A file larger than the file API can write MUST be
 * refused before it is read, since the session could never save it. So MUST a file the file API
 * reads without a revision (`toMountFilePath` gives it no storage path), with
 * `unsupported_location`, since none of its saves could be conditional. `canWrite` MUST be the
 * file system's write check for that path.
 */
export async function openCollabAccess(
  auth: Authenticator,
  canonicalPath: string
): Promise<Result<CollabAccess, CollabFileError>> {
  const workspace = auth.workspace();
  if (!workspace) {
    return new Err({ code: "unavailable", message: "No workspace." });
  }
  // A trailing slash survives normalization but names the same file.
  if (
    DustFileSystem.normalizeScopedPath(canonicalPath) !== canonicalPath ||
    canonicalPath.endsWith("/")
  ) {
    return new Err({
      code: "invalid_path",
      message: "Open the file by its normalized path.",
    });
  }

  const dustFs = await DustFileSystem.fromScopedPath(auth, canonicalPath);
  if (dustFs.isErr()) {
    return new Err({ code: "unavailable", message: dustFs.error.message });
  }
  if (dustFs.value.toMountFilePath(canonicalPath) === null) {
    return new Err({
      code: "unsupported_location",
      message: "Only files in a conversation or a Pod can be edited live.",
    });
  }
  const stat = await dustFs.value.stat(canonicalPath);
  if (stat.isErr()) {
    return new Err({ code: "unavailable", message: stat.error.message });
  }
  if (stat.value === null) {
    return new Err({ code: "unavailable", message: "File not found." });
  }
  // Directories have their own type, so they are refused here too.
  if (!isMarkdownContentType(stripMimeParameters(stat.value.contentType))) {
    return new Err({
      code: "not_markdown",
      message: "Only Markdown files open in a live session.",
    });
  }
  if (stat.value.sizeBytes > WRITE_CANONICAL_FILE_CONTENT_MAX_BYTES) {
    return new Err({
      code: "too_large",
      message: "This file is too large to edit live.",
    });
  }

  return new Ok({
    auth,
    workspaceId: workspace.sId,
    canonicalPath,
    dustFs: dustFs.value,
    canWrite: dustFs.value.checkWriteAccess(canonicalPath).isOk(),
  });
}

/** Why a user may not open or keep a file in a live session. */
export type CollabAccessError =
  | { code: "not_member"; message: string }
  | { code: "not_available"; message: string }
  | { code: "read_only"; message: string }
  | {
      code: "workspace_unavailable";
      message: string;
      workspaceError: WorkspaceAccessError;
    }
  | CollabFileError;

const READ_ONLY: CollabAccessError = {
  code: "read_only",
  message: "Live editing needs write access to this file.",
};

/** Membership, `co_edition` and the workspace's status: a live session's needs besides the file. */
async function checkCollabRights(
  auth: Authenticator
): Promise<Result<void, CollabAccessError>> {
  if (!auth.user() || !auth.isUser()) {
    return new Err({
      code: "not_member",
      message: "Not a member of this workspace.",
    });
  }
  const hasCoEdition = await hasFeatureFlag(auth, "co_edition");
  if (!hasCoEdition) {
    return new Err({
      code: "not_available",
      message: "Live editing is not available here.",
    });
  }
  const workspaceError = validateWorkspaceAccess(auth);
  if (workspaceError) {
    return new Err({
      code: "workspace_unavailable",
      message: `This workspace is not available (${workspaceError.type}).`,
      workspaceError,
    });
  }
  return new Ok(undefined);
}

/**
 * @cc [owner:PopDaph,label:security] collab-access
 * A live session MUST be written only by a member of the workspace, in a workspace with
 * `co_edition` that `validateWorkspaceAccess` lets through, for a file `openCollabAccess` opens for
 * them with write access. `auth` MUST be built for this check: an Authenticator keeps the
 * membership, plan and workspace it was built with.
 */
export async function checkCollabAccess(
  auth: Authenticator,
  canonicalPath: string
): Promise<Result<CollabAccess, CollabAccessError>> {
  const rights = await checkCollabRights(auth);
  if (rights.isErr()) {
    return new Err(rights.error);
  }
  const file = await openCollabAccess(auth, canonicalPath);
  if (file.isOk() && !file.value.canWrite) {
    return new Err(READ_ONLY);
  }
  return file;
}

/**
 * @cc [owner:tdraier,label:security] collab-read-access
 * Opening a live session or reading a live document's source MUST apply the same membership,
 * `co_edition` and workspace checks as `checkCollabAccess`, for a file `openCollabAccess` opens for
 * the user, without requiring write access: a reader may read what the session holds, never change
 * it. Minting a ticket and connecting MUST both go through it.
 */
export async function checkCollabReadAccess(
  auth: Authenticator,
  canonicalPath: string
): Promise<Result<CollabAccess, CollabAccessError>> {
  const rights = await checkCollabRights(auth);
  if (rights.isErr()) {
    return new Err(rights.error);
  }
  return openCollabAccess(auth, canonicalPath);
}

/**
 * @cc [owner:PopDaph,label:security;performance] collab-recheck-access
 * Re-checking an open session MUST apply the same membership, `co_edition` and workspace checks as
 * `checkCollabReadAccess`, with an Authenticator built for it, and MUST return the file system's
 * write check for the path as `canWrite`. It MUST NOT read the file from storage: existence, type
 * and size do not decide access, and a re-check runs for every open session.
 */
export async function recheckCollabAccess(
  auth: Authenticator,
  canonicalPath: string
): Promise<Result<{ canWrite: boolean }, CollabAccessError>> {
  const rights = await checkCollabRights(auth);
  if (rights.isErr()) {
    return new Err(rights.error);
  }
  // TODO(co-edition step 8): a file deleted or moved during a session keeps it open, failing to
  // save; the per-file lock and the stable file id end those sessions.
  const dustFs = await DustFileSystem.fromScopedPath(auth, canonicalPath);
  if (dustFs.isErr()) {
    return new Err({ code: "unavailable", message: dustFs.error.message });
  }
  return new Ok({
    canWrite: dustFs.value.checkWriteAccess(canonicalPath).isOk(),
  });
}
