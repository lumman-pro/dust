import { FILE_OFFLOAD_TEXT_SIZE_BYTES } from "@app/lib/actions/action_output_limits";
import { isResourceContentWithText } from "@app/lib/actions/mcp_internal_actions/output_schemas";
import type {
  SandboxFunctionRunContext,
  ToolRunContext,
} from "@app/lib/actions/types";
import { DustFileSystem } from "@app/lib/api/file_system/dust_file_system";
import { makeFileName } from "@app/lib/api/files/action_output_fs/naming";
import {
  resolveResourceOutput,
  shouldOffloadTextBlock,
} from "@app/lib/api/files/action_output_fs/registry";
import type { Authenticator } from "@app/lib/auth";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import logger from "@app/logger/logger";
import type { ConversationWithoutContentType } from "@app/types/assistant/conversation";
import {
  conversationScopedPath,
  frameScopedPath,
  podScopedPath,
} from "@app/types/file_system";
import type { AllSupportedFileContentType } from "@app/types/files";
import {
  getFramePersistentFilesMountPoint,
  TOOL_OUTPUTS_FOLDER_NAME,
} from "@app/types/mount_path";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import { slugify } from "@app/types/shared/utils/string_utils";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface PersistedToolOutput {
  contentType: AllSupportedFileContentType;
  fileName: string;
  scopedPath: string;
  // Byte size of the persisted content, surfaced in the offload descriptor attached to the
  // replacement snippet block.
  totalBytes: number;
}

/**
 * Builds the DustFileSystem for agent-loop tool-output offload (conversation mount only).
 * Sandbox function invocations must not use conversation/pod `.tool_outputs`: Frame sandboxes
 * do not mount `/files/pod-*` or conversation mounts. Use `writeToFramePersistentFilesFolder`.
 */
async function getDustFileSystemForRunContext(
  auth: Authenticator,
  runContext: ToolRunContext
): Promise<Result<DustFileSystem, Error>> {
  switch (runContext.contextType) {
    case "agent_loop":
      return DustFileSystem.forConversation(auth, runContext.conversation);
    case "sandbox_function":
      return new Err(
        new Error(
          "Frame function tools cannot write conversation/pod .tool_outputs; use the Frame persistent files folder."
        )
      );
    default:
      return assertNever(runContext);
  }
}

function getToolOutputsScopedPath(
  runContext: ToolRunContext,
  fileName: string
): Result<string, Error> {
  switch (runContext.contextType) {
    case "agent_loop":
      return new Ok(
        conversationScopedPath({
          conversationId: runContext.conversation.sId,
          rel: `${TOOL_OUTPUTS_FOLDER_NAME}/${fileName}`,
        })
      );
    case "sandbox_function":
      return new Err(
        new Error(
          "Frame function tools cannot write conversation/pod .tool_outputs; use the Frame persistent files folder."
        )
      );
    default:
      return assertNever(runContext);
  }
}

/**
 * Writes content to the conversation root via DustFileSystem.
 * Returns the scoped path (e.g. "conversation-{cId}/{fileName}") on success.
 * Use for user-facing generated files (PDFs, audio, etc.) that should be visible at the top level.
 * Use writeToToolOutputsFolder for internal outputs the model reads back during execution.
 */
export async function writeToConversationFolder(
  auth: Authenticator,
  conversation: ConversationWithoutContentType,
  {
    content,
    contentType,
    fileName,
  }: {
    content: string | Buffer;
    contentType: string;
    fileName: string;
  }
): Promise<Result<string, Error>> {
  const fsResult = await DustFileSystem.forConversation(auth, conversation);
  if (fsResult.isErr()) {
    return new Err(new Error(fsResult.error.message));
  }

  const scopedPath = conversationScopedPath({
    conversationId: conversation.sId,
    rel: fileName,
  });
  const writeResult = await fsResult.value.write(
    scopedPath,
    content,
    contentType
  );
  if (writeResult.isErr()) {
    return new Err(new Error(writeResult.error.message));
  }

  return new Ok(scopedPath);
}

/**
 * Writes content to the pod (project space) root via DustFileSystem.
 * Returns the scoped path (e.g. "pod-{spaceId}/{fileName}") on success.
 * Use for user-facing generated files (PDFs, audio, etc.) that should be visible at the top level.
 * Use writeToToolOutputsFolder for internal outputs the model reads back during execution.
 */
export async function writeToPodFolder(
  auth: Authenticator,
  space: SpaceResource,
  {
    content,
    contentType,
    fileName,
  }: {
    content: string | Buffer;
    contentType: string;
    fileName: string;
  }
): Promise<Result<string, Error>> {
  const fsResult = await DustFileSystem.forPod(auth, space);
  if (fsResult.isErr()) {
    return new Err(new Error(fsResult.error.message));
  }

  const scopedPath = podScopedPath(space.sId, fileName);
  const writeResult = await fsResult.value.write(
    scopedPath,
    content,
    contentType
  );
  if (writeResult.isErr()) {
    return new Err(new Error(writeResult.error.message));
  }

  return new Ok(scopedPath);
}

/**
 * Writes content to the conversation `.tool_outputs` folder (agent-loop only) via DustFileSystem.
 * Returns the scoped path (e.g. "conversation-{cId}/.tool_outputs/{fileName}") on success.
 * Refuses sandbox_function contexts — use `writeToFramePersistentFilesFolder` instead.
 */
export async function writeToToolOutputsFolder(
  auth: Authenticator,
  runContext: ToolRunContext,
  {
    fileName,
    content,
    contentType,
  }: {
    fileName: string;
    content: string | Buffer;
    contentType: AllSupportedFileContentType;
  }
): Promise<Result<string, Error>> {
  const fsResult = await getDustFileSystemForRunContext(auth, runContext);
  if (fsResult.isErr()) {
    return new Err(new Error(fsResult.error.message));
  }

  const scopedPath = getToolOutputsScopedPath(runContext, fileName);
  if (scopedPath.isErr()) {
    return scopedPath;
  }

  const writeResult = await fsResult.value.write(
    scopedPath.value,
    content,
    contentType
  );
  if (writeResult.isErr()) {
    return new Err(new Error(writeResult.error.message));
  }

  return new Ok(scopedPath.value);
}

export type FramePersistentFileWrite = {
  /** DustFileSystem scoped path, e.g. `frame-{frameId}/.tool_outputs/{slug}/{file}`. */
  scopedPath: string;
  /**
   * Absolute path inside the Frame sandbox (under `persistentFilesDir()` /
   * `DUST_FRAME_PERSISTENT_FILES_DIR`), suitable for `node:fs`.
   */
  sandboxPath: string;
};

/**
 * Embedded in sandbox_function tool `structuredContent` so Frame authors get a copy-pasteable
 * `node:fs` read from the first exploratory `tools.call` (prefer `result.json()`).
 * Paths are absolute under the Frame mount — do not pass them to `useFile()`.
 */
export function frameSandboxFilePathHint(
  path: string,
  { encoding }: { encoding?: "utf8" } = {}
): string {
  const call =
    encoding === "utf8"
      ? `await readFile(${JSON.stringify(path)}, "utf8")`
      : `await readFile(${JSON.stringify(path)})`;
  return `Read with node:fs/promises: ${call}. Do not pass this path to useFile().`;
}

/** Max rows included in sandbox query `structuredContent.rows` (full CSV remains at `path`). */
export const FRAME_SANDBOX_QUERY_RESULT_PREVIEW_ROWS = 100;

/**
 * Writes content into the Frame's persistent files folder for a sandbox_function tool run.
 * Same GCS prefix the Frame sandbox mounts at `/frames/{frameId}/files`. Namespaced under
 * `.tool_outputs/{functionSlug}/` so outputs from different functions do not collide.
 *
 * Auth: call only with a `SandboxFunctionRunContext` for the Frame that owns the invocation;
 * do not re-check `authMethod` (approval/personal-auth resume may use session auth).
 */
export async function writeToFramePersistentFilesFolder(
  auth: Authenticator,
  runContext: SandboxFunctionRunContext,
  {
    fileName,
    content,
    contentType,
  }: {
    fileName: string;
    content: string | Buffer;
    contentType: AllSupportedFileContentType;
  }
): Promise<Result<FramePersistentFileWrite, Error>> {
  const { frame } = runContext.invocation.sandboxFunction;
  const fsResult = await DustFileSystem.forFramePersistentFiles(auth, frame);
  if (fsResult.isErr()) {
    return new Err(new Error(fsResult.error.message));
  }

  const rel = `${TOOL_OUTPUTS_FOLDER_NAME}/${runContext.invocation.sandboxFunction.slug}/${fileName}`;
  const scopedPath = frameScopedPath(frame.sId, rel);
  const writeResult = await fsResult.value.write(
    scopedPath,
    content,
    contentType
  );
  if (writeResult.isErr()) {
    return new Err(new Error(writeResult.error.message));
  }

  const sandboxPathResult = fsResult.value.toSandboxPath(scopedPath);
  if (sandboxPathResult.isErr()) {
    // Mount point is always set for frame mounts; fall back to the known mount root.
    return new Ok({
      scopedPath,
      sandboxPath: `${getFramePersistentFilesMountPoint(frame.sId)}/${rel}`,
    });
  }

  return new Ok({
    scopedPath,
    sandboxPath: sandboxPathResult.value,
  });
}

/**
 * Attempts to persist a tool output block to the run context's .tool_outputs folder via
 * DustFileSystem. Returns null if the block does not qualify for persistence.
 *
 * Sandbox function invocations never offload here: Frame sandboxes do not mount
 * `/files/pod-*`, so dsbx cannot rehydrate an archive written to the pod FS. Large outputs
 * stay inline on the action output / poll path instead.
 *
 * Call this as a side effect from processToolResults.
 */
export async function persistToolOutput(
  auth: Authenticator,
  runContext: ToolRunContext,
  block: CallToolResult["content"][number],
  { toolName, serverName }: { toolName: string; serverName: string }
): Promise<Result<PersistedToolOutput | null, Error>> {
  if (runContext.contextType === "sandbox_function") {
    logger.info(
      {
        actionId: runContext.action.sId,
        invocationId: runContext.invocation.sId,
        toolName,
        serverName,
        hasPod: runContext.pod != null,
      },
      "Sandbox function tool output kept inline; Frame sandboxes cannot rehydrate pod offloads."
    );
    return new Ok(null);
  }

  // Resource blocks (registered mimeTypes).
  const resolved = resolveResourceOutput(block);
  if (resolved) {
    const { fileName: rawName, content, storageContentType } = resolved;
    const ext = storageContentType === "application/json" ? ".json" : ".md";
    const fileName = makeFileName({ name: rawName, ext });

    const result = await writeToToolOutputsFolder(auth, runContext, {
      fileName,
      content,
      contentType: storageContentType,
    });
    if (result.isErr()) {
      return result;
    }

    return new Ok({
      fileName,
      scopedPath: result.value,
      contentType: storageContentType,
      totalBytes: Buffer.byteLength(content, "utf8"),
    });
  }

  // Text blocks above the offload threshold.
  if (shouldOffloadTextBlock(block, { serverName })) {
    const { fileName, contentType } = inferTextFileMetadata(
      block.text,
      toolName
    );

    const result = await writeToToolOutputsFolder(auth, runContext, {
      fileName,
      content: block.text,
      contentType,
    });
    if (result.isErr()) {
      return result;
    }

    return new Ok({
      fileName,
      scopedPath: result.value,
      contentType,
      totalBytes: Buffer.byteLength(block.text, "utf8"),
    });
  }

  // Resource blocks whose text exceeds the offload threshold.
  if (
    isResourceContentWithText(block) &&
    Buffer.byteLength(block.resource.text, "utf8") >
      FILE_OFFLOAD_TEXT_SIZE_BYTES
  ) {
    const text = block.resource.text;
    const { fileName, contentType } = inferTextFileMetadata(text, toolName);

    const result = await writeToToolOutputsFolder(auth, runContext, {
      fileName,
      content: text,
      contentType,
    });
    if (result.isErr()) {
      return result;
    }

    return new Ok({
      fileName,
      scopedPath: result.value,
      contentType,
      totalBytes: Buffer.byteLength(text, "utf8"),
    });
  }

  return new Ok(null);
}

/**
 * Infers filename and content-type for a plain text block.
 * Sniffs for JSON to assign a .json extension; falls back to .txt.
 */
function inferTextFileMetadata(
  text: string,
  toolName: string
): { fileName: string; contentType: AllSupportedFileContentType } {
  const trimmed = text.trimStart();
  const isJson =
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (() => {
      try {
        JSON.parse(text);
        return true;
      } catch {
        return false;
      }
    })();

  const slug = slugify(toolName) || "output";
  return isJson
    ? {
        fileName: makeFileName({ name: slug, ext: ".json" }),
        contentType: "application/json",
      }
    : {
        fileName: makeFileName({ name: slug, ext: ".txt" }),
        contentType: "text/plain",
      };
}
