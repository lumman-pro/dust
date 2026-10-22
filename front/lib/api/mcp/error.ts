import type { MCPErrorEvent, MCPSuccessEvent } from "@app/lib/actions/mcp";
import type { ToolExecutionStatus } from "@app/lib/actions/statuses";
import { isToolExecutionStatusFinal } from "@app/lib/actions/statuses";
import type { Authenticator } from "@app/lib/auth";
import type { AgentMCPActionResource } from "@app/lib/resources/agent_mcp_action_resource";
import type { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import logger from "@app/logger/logger";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

type HandleErrorParams = {
  action: AgentMCPActionResource | SandboxFunctionMCPActionResource;
  errorContent: CallToolResult["content"];
  status: ToolExecutionStatus;
  executionDurationMs: number;
  onPersistProgress: () => void;
};

/**
 * Handles MCP action errors with type-safe discriminated union based on error severity.
 */
export async function handleMCPActionError(
  auth: Authenticator,
  {
    action,
    errorContent,
    status,
    executionDurationMs,
    onPersistProgress,
  }: HandleErrorParams
): Promise<MCPErrorEvent | MCPSuccessEvent> {
  const outputRes = await action.createOutputItems(
    auth,
    errorContent.map((item) => ({ content: item })),
    { deferDurablePersist: true, onProgress: onPersistProgress }
  );
  if (outputRes.isErr()) {
    throw outputRes.error;
  }

  // If the tool is not already in a final state, we set it to errored (could be denied).
  if (!isToolExecutionStatusFinal(status)) {
    await action.markAsErrored({ executionDurationMs });
  }

  // The content is already staged, so a failed durable write must not kill the agent loop.
  const persistResult = await action.awaitDeferredOutputPersist();
  if (persistResult.isErr()) {
    logger.error(
      { err: persistResult.error, actionId: action.sId },
      "Failed to durably persist MCP tool output after error"
    );
  }

  // Yields tool_success to continue the conversation.
  return {
    type: "tool_success",
    created: Date.now(),
    output: errorContent,
    generatedFiles: [],
  };
}
