import { formatDfsUri } from "@app/lib/dfs/uri";
import type { DfsObjectId } from "@app/types/dfs";
import { DfsError } from "@app/types/dfs";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

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

function encodePodName(name: string): string {
  return [...name]
    .map((char, i) =>
      char === "%" ||
      char === "/" ||
      /\p{Cc}/u.test(char) ||
      (i === 0 && char === ".")
        ? percentEncode(char)
        : char
    )
    .join("");
}

/** Whether the folder name of a pod named `name` would exceed dfs's basename limit. */
/**
 * @cc [owner:fabiencelier,label:product] pod-name-fits-folder
 * Creating a pod (`createSpaceAndGroup`) and renaming one (`SpaceResource.updateName`) MUST fail
 * with `pod_name_too_long`, without changing anything, when this is true for the new name, so that
 * every pod name gives a valid folder name.
 */
export function isPodNameTooLong(name: string): boolean {
  return Buffer.byteLength(encodePodName(name)) > MAX_NAME_BYTES;
}

/**
 * The name of the folder of the pod named `name`, see `pod-folder-name`.
 */
/**
 * @cc [owner:fabiencelier,label:product] pod-folder-name
 * The name MUST be the pod's name with only `%`, `/`, control characters and a leading `.`
 * percent-encoded (UTF-8 bytes, `%XX`), so that two different pod names never give the same folder
 * name. An empty name, or one longer than 255 UTF-8 bytes once encoded, MUST fail with
 * `invalid_input`: it is never cut or replaced.
 */
export function podFolderName(name: string): Result<string, DfsError> {
  const encoded = encodePodName(name);
  if (encoded === "" || Buffer.byteLength(encoded) > MAX_NAME_BYTES) {
    return new Err(
      new DfsError(
        "invalid_input",
        `The pod name gives a folder name of ${Buffer.byteLength(encoded)} bytes, not 1 to ${MAX_NAME_BYTES}.`
      )
    );
  }
  return new Ok(encoded);
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
