import { MCPError } from "@app/lib/actions/mcp_errors";
import type {
  ToolHandlerExtra,
  ToolHandlerResult,
  ToolHandlers,
} from "@app/lib/actions/mcp_internal_actions/tool_definition";
import { buildTools } from "@app/lib/actions/mcp_internal_actions/tool_definition";
import type { AgentLoopRunContext } from "@app/lib/actions/types";
import { isAgentLoopRunContext } from "@app/lib/actions/types";
import {
  DOCUMENTS_TOOLS_METADATA,
  READ_DOCUMENT_MAX_BYTES,
} from "@app/lib/api/actions/servers/documents/metadata";
import { getDustFileSystemForAgentLoop } from "@app/lib/api/actions/servers/files/tools/agent_loop_fs";
import type { DfmAgentCommentError } from "@app/lib/api/documents/agent_comments";
import {
  addAgentComment,
  replyToAgentComment,
} from "@app/lib/api/documents/agent_comments";
import type { DfmAgentDocumentError } from "@app/lib/api/documents/agent_edit_source";
import {
  editAgentDocument,
  readAgentDocument,
} from "@app/lib/api/documents/agent_edits";
import { toCollabAgent } from "@app/lib/api/documents/comment_activity";
import type { DfmStoredDocumentError } from "@app/lib/api/documents/read_write";
import type { DustFileSystem } from "@app/lib/api/file_system";
import type { Authenticator } from "@app/lib/auth";
import { Err, Ok } from "@app/types/shared/result";
import { pluralize } from "@app/types/shared/utils/string_utils";

/** Runs a tool against the conversation's file system, scoped to the document it targets. */
async function withDocumentFs(
  path: string,
  { auth, runContext }: ToolHandlerExtra,
  run: (
    dustFs: DustFileSystem,
    runContext: AgentLoopRunContext,
    auth: Authenticator
  ) => Promise<ToolHandlerResult>
): Promise<ToolHandlerResult> {
  if (!isAgentLoopRunContext(runContext)) {
    return new Err(
      new MCPError("No conversation context available.", { tracked: false })
    );
  }

  const dustFs = await getDustFileSystemForAgentLoop(
    auth,
    runContext.conversation,
    [path]
  );
  if (dustFs.isErr()) {
    return dustFs;
  }

  return run(dustFs.value, runContext, auth);
}

/** Only storage failures are ours; every other error is the agent's to fix. */
function toDocumentsMCPError({
  code,
  message,
}:
  | DfmStoredDocumentError
  | DfmAgentCommentError
  | DfmAgentDocumentError): MCPError {
  return new MCPError(message, { tracked: code === "storage_failed" });
}

const handlers: ToolHandlers<typeof DOCUMENTS_TOOLS_METADATA> = {
  add_comment: ({ path, quote, occurrence, comment }, extra) =>
    withDocumentFs(path, extra, async (dustFs, runContext, auth) => {
      const added = await addAgentComment(auth, dustFs, {
        agent: runContext.agentConfiguration,
        scopedPath: path,
        quote,
        occurrence: occurrence ?? 1,
        comment,
      });
      if (added.isErr()) {
        return new Err(toDocumentsMCPError(added.error));
      }

      return new Ok([
        {
          type: "text",
          text: `Added comment \`${added.value.commentId}\` on "${quote}" in \`${path}\`.`,
        },
      ]);
    }),
  reply_to_comment: ({ path, comment_id, reply }, extra) =>
    withDocumentFs(path, extra, async (dustFs, runContext, auth) => {
      const replied = await replyToAgentComment(auth, dustFs, {
        agent: runContext.agentConfiguration,
        scopedPath: path,
        commentId: comment_id,
        reply,
      });
      if (replied.isErr()) {
        return new Err(toDocumentsMCPError(replied.error));
      }

      return new Ok([
        {
          type: "text",
          text: `Replied in comment \`${comment_id}\` in \`${path}\`.`,
        },
      ]);
    }),
  read_document: ({ path }, extra) =>
    withDocumentFs(path, extra, async (dustFs, runContext, auth) => {
      const read = await readAgentDocument(
        auth,
        dustFs,
        path,
        toCollabAgent(runContext)
      );
      if (read.isErr()) {
        return new Err(toDocumentsMCPError(read.error));
      }
      if (
        Buffer.byteLength(read.value.source, "utf8") > READ_DOCUMENT_MAX_BYTES
      ) {
        return new Err(
          new MCPError(
            `\`${path}\` exceeds the ${READ_DOCUMENT_MAX_BYTES / 1024} KB limit of this tool.`,
            { tracked: false }
          )
        );
      }

      return new Ok([{ type: "text", text: read.value.source }]);
    }),
  edit_document: (
    { path, old_string, new_string, expected_replacements },
    extra
  ) =>
    withDocumentFs(path, extra, async (dustFs, runContext, auth) => {
      const edited = await editAgentDocument(auth, dustFs, {
        scopedPath: path,
        oldString: old_string,
        newString: new_string,
        expectedReplacements: expected_replacements ?? 1,
        agent: toCollabAgent(runContext),
      });
      if (edited.isErr()) {
        return new Err(toDocumentsMCPError(edited.error));
      }

      const { replacements } = edited.value;
      return new Ok([
        {
          type: "text",
          text: `Updated \`${path}\`: made ${replacements} replacement${pluralize(replacements)}.`,
        },
      ]);
    }),
};

export const TOOLS = buildTools(DOCUMENTS_TOOLS_METADATA, handlers);
