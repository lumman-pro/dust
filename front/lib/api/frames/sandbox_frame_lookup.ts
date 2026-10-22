import path from "node:path";

import { DustFileSystem } from "@app/lib/api/file_system";
import type {
  SandboxExecTokenPayload,
  SandboxTokenPayload,
} from "@app/lib/api/sandbox/access_tokens";
import { isSandboxExecTokenPayload } from "@app/lib/api/sandbox/access_tokens";
import type { Authenticator } from "@app/lib/auth";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { FileResource } from "@app/lib/resources/file_resource";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export class SandboxFrameLookupError extends Error {
  constructor(
    readonly code:
      | "token_not_allowed"
      | "conversation_not_found"
      | "invalid_source"
      | "frame_not_in_conversation"
      | "frame_not_found",
    message: string
  ) {
    super(message);
    this.name = "SandboxFrameLookupError";
  }
}

function lookupError(
  code: SandboxFrameLookupError["code"],
  message: string
): Err<SandboxFrameLookupError> {
  return new Err(new SandboxFrameLookupError(code, message));
}

/**
 * @cc [owner:davidebbo,label:product;security] writable-sandbox-frame-stays-in-conversation
 * MUST resolve only a Frames v2 Frame already registered at the given `manifest.json`, MUST NOT
 * create one, and MUST refuse with `frame_not_in_conversation` a path the exec token's
 * conversation file system (its conversation plus its Pod) cannot write, even when the user can
 * write the Frame elsewhere. The sandbox draft-mode and make-live routes MUST resolve their Frame
 * through here.
 */
export async function resolveWritableSandboxFrame(
  auth: Authenticator,
  {
    claims,
    manifestPath,
  }: { claims: SandboxTokenPayload; manifestPath: string }
): Promise<
  Result<
    { claims: SandboxExecTokenPayload; frame: FileResource },
    SandboxFrameLookupError
  >
> {
  if (!isSandboxExecTokenPayload(claims)) {
    return lookupError(
      "token_not_allowed",
      "This sandbox token cannot act on Frames."
    );
  }
  const conversation = await ConversationResource.fetchById(auth, claims.cId);
  if (!conversation) {
    return lookupError(
      "conversation_not_found",
      `Conversation ${claims.cId} not found.`
    );
  }

  const scopedPath = DustFileSystem.normalizeScopedPath(manifestPath);
  if (!scopedPath || path.posix.basename(scopedPath) !== FRAME_MANIFEST_FILE) {
    return lookupError(
      "invalid_source",
      `Expected a Frames v2 manifest path ending in ${FRAME_MANIFEST_FILE}.`
    );
  }
  const fsResult = await DustFileSystem.forConversation(
    auth,
    conversation.toJSON()
  );
  if (fsResult.isErr()) {
    return lookupError("frame_not_in_conversation", fsResult.error.message);
  }
  const dustFs = fsResult.value;
  if (dustFs.checkWriteAccess(scopedPath).isErr()) {
    return lookupError(
      "frame_not_in_conversation",
      "This Frame is not in this conversation's files."
    );
  }

  const mountFilePath = dustFs.toMountFilePath(scopedPath);
  const [frame] = mountFilePath
    ? await FileResource.fetchByMountFilePaths(auth, [mountFilePath])
    : [];
  if (!frame?.isFrameV2) {
    return lookupError(
      "frame_not_found",
      `No published Frame found at ${scopedPath}. Publish it first.`
    );
  }
  return new Ok({ claims, frame });
}
