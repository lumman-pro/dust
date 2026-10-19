import { formatDfsUri } from "@app/lib/dfs/uri";
import type { DfsObjectId } from "@app/types/dfs";

/**
 * URIs of the context folders of `dfs/design-docs/URI.md`, each anchored at the folder that holds
 * it: user folders at the tenant root, pod folders and conversations outside pods at their owner's
 * user folder, conversations of a pod at the pod folder.
 */
/**
 * @cc [owner:fabiencelier,label:product] folder-layout
 * The URIs MUST follow the layout of `dfs/design-docs/URI.md`: `users/<userSId>` under the tenant
 * root, `pods/<podFolderName(podName)>` and `.conversations/conv-<conversationSId>` under their
 * parent folder. Changing a name orphans the folders already created under the previous one.
 */
export function userFolderUri(rootId: DfsObjectId, userId: string): string {
  return formatDfsUri(rootId, { path: ["users", userId] });
}

export function podFolderUri(
  userFolderId: DfsObjectId,
  pod: { sId: string; name: string }
): string {
  return formatDfsUri(userFolderId, { path: ["pods", podFolderName(pod)] });
}

// See "Stored basenames" in `dfs/design-docs/API.md`.
const MAX_NAME_BYTES = 255;

/**
 * @cc [owner:fabiencelier,label:product] pod-folder-name
 * The name MUST be a valid dfs basename derived from the pod's name: `/` and control characters are
 * replaced with `-`, surrounding whitespace and leading dots are removed (so that it is never `.`,
 * `..` or hidden), and it is cut to 255 UTF-8 bytes without splitting a character. A pod name with
 * nothing left MUST fall back to `pod-<podSId>`. Different pods MAY get the same name.
 */
export function podFolderName({
  sId,
  name,
}: {
  sId: string;
  name: string;
}): string {
  const cleaned = name.replace(/[/\p{Cc}]/gu, "-").replace(/^[\s.]+/u, "");
  let truncated = "";
  for (const char of cleaned) {
    if (Buffer.byteLength(truncated + char) > MAX_NAME_BYTES) {
      break;
    }
    truncated += char;
  }
  truncated = truncated.trimEnd();
  return truncated || `pod-${sId}`;
}

/**
 * `parentFolderId` is the pod folder for a conversation of a pod, else the owner's user folder.
 */
export function conversationFolderUri(
  parentFolderId: DfsObjectId,
  conversationId: string
): string {
  return formatDfsUri(parentFolderId, {
    path: [".conversations", `conv-${conversationId}`],
  });
}
