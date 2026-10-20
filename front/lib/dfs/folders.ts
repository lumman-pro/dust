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
 * root, `pods/<one of podFolderNames(pod)>` and `.conversations/conv-<conversationSId>` under
 * their parent folder. Changing a name orphans the folders already created under the previous one.
 */
export function userFolderUri(rootId: DfsObjectId, userId: string): string {
  return formatDfsUri(rootId, { path: ["users", userId] });
}

export function podFolderUri(
  userFolderId: DfsObjectId,
  folderName: string
): string {
  return formatDfsUri(userFolderId, { path: ["pods", folderName] });
}

// See "Stored basenames" in `dfs/design-docs/API.md`.
const MAX_NAME_BYTES = 255;

function percentEncode(char: string): string {
  return [...Buffer.from(char, "utf8")]
    .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
}

// The pod name split into encoded characters (see `pod-folder-names`), so that truncating never
// cuts an escape sequence.
function encodedPodNameChars(name: string): string[] {
  return [...name].map((char, i) =>
    char === "%" ||
    char === "/" ||
    /\p{Cc}/u.test(char) ||
    (i === 0 && char === ".")
      ? percentEncode(char)
      : char
  );
}

/**
 * The names to try, in order, for the folder of `pod`, see `pod-folder-names`.
 */
/**
 * @cc [owner:fabiencelier,label:product] pod-folder-names
 * The first name MUST be the pod's name with only `%`, `/`, control characters and a leading `.`
 * percent-encoded (UTF-8 bytes, `%XX`), so that two different pod names never give the same folder
 * name; it is omitted when empty or longer than 255 UTF-8 bytes. The last name MUST be that encoded
 * name, cut without splitting a character or an escape sequence, followed by ` (<podSId>)`, within
 * 255 bytes, or `pod-<podSId>` for an empty pod name: it is unique to the pod.
 */
export function podFolderNames({
  sId,
  name,
}: {
  sId: string;
  name: string;
}): string[] {
  const chars = encodedPodNameChars(name);
  const encoded = chars.join("");
  if (encoded === "") {
    return [`pod-${sId}`];
  }
  const suffix = ` (${sId})`;
  let truncated = "";
  for (const char of chars) {
    if (Buffer.byteLength(truncated + char + suffix) > MAX_NAME_BYTES) {
      break;
    }
    truncated += char;
  }
  const unique = `${truncated}${suffix}`;
  return Buffer.byteLength(encoded) <= MAX_NAME_BYTES
    ? [encoded, unique]
    : [unique];
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
