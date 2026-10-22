import type { AgentLoopBlockedToolExecution } from "@app/lib/actions/mcp";
import { isBlockedActionEvent } from "@app/lib/actions/mcp";
import {
  getInternalMCPServerDisplayedAs,
  getInternalMCPServerNameFromSId,
} from "@app/lib/actions/mcp_internal_actions/constants";
import {
  collectApprovalArgsLabelResourceIds,
  getApprovalArgsLabel,
} from "@app/lib/actions/tool_approval_labels";
import { getToolDisplayLabels } from "@app/lib/actions/tool_display_labels";
import { getMessageChannelId } from "@app/lib/api/assistant/streaming/helpers";
import {
  buildAuditLogTarget,
  emitAuditLogEventDirect,
} from "@app/lib/api/audit/workos_audit";
import { getRedisHybridManager } from "@app/lib/api/redis-hybrid-manager";
import type { Authenticator } from "@app/lib/auth";
import { AgentMCPActionResource } from "@app/lib/resources/agent_mcp_action_resource";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { FileResource } from "@app/lib/resources/file_resource";
import { MCPServerViewResource } from "@app/lib/resources/mcp_server_view_resource";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import logger from "@app/logger/logger";
import type {
  AgentMessageType,
  ConversationWithoutContentType,
} from "@app/types/assistant/conversation";
import { normalizeError } from "@app/types/shared/utils/error_utils";

export type GetBlockedActionsResponseType = {
  blockedActions: AgentLoopBlockedToolExecution[];
};

/**
 * Agent-loop blocked actions plus Frame-function tools blocked while invoked via
 * `dsbx frame call` from this conversation.
 */
export async function listConversationBlockedActions(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<AgentLoopBlockedToolExecution[]> {
  const [agentBlocked, sandboxFunctionBlocked] = await Promise.all([
    AgentMCPActionResource.listBlockedActionsForConversation(
      auth,
      conversation
    ),
    listSandboxFunctionBlockedActionsForConversation(auth, conversation),
  ]);

  return [...agentBlocked, ...sandboxFunctionBlocked].sort(
    (a, b) => a.created - b.created
  );
}

/**
 * Present blocked Frame-function tools for this conversation. Retrieval is on the resource;
 * serialization stays here to avoid resource ↔ presentation import cycles.
 */
async function listSandboxFunctionBlockedActionsForConversation(
  auth: Authenticator,
  conversation: ConversationResource
): Promise<AgentLoopBlockedToolExecution[]> {
  const owner = auth.getNonNullableWorkspace();
  const rows =
    await SandboxFunctionMCPActionResource.listBlockedForConversation(auth, {
      conversationId: conversation.sId,
    });

  if (rows.length === 0) {
    return [];
  }

  const mcpServerViewModelIds = [
    ...new Set(rows.map(({ action }) => action.mcpServerViewId)),
  ];
  const mcpServerViews = await MCPServerViewResource.fetchByModelIds(
    auth,
    mcpServerViewModelIds
  );
  const mcpServerViewByModelId = new Map(
    mcpServerViews.map((view) => [view.id, view])
  );

  const { spaceIds, fileIds } = collectApprovalArgsLabelResourceIds(
    rows.map(({ action }) => ({
      inputs: action.inputs,
      argumentsRequiringApproval:
        action.toolConfiguration.argumentsRequiringApproval ?? [],
    }))
  );
  const [spaces, files] = await Promise.all([
    spaceIds.length > 0
      ? SpaceResource.fetchByIds(auth, spaceIds)
      : Promise.resolve([]),
    fileIds.length > 0
      ? FileResource.fetchByIds(auth, fileIds)
      : Promise.resolve([]),
  ]);
  const approvalLabelCaches = {
    spacesById: new Map(spaces.map((space) => [space.sId, space])),
    filesById: new Map(files.map((file) => [file.sId, file])),
  };

  const blockedActionsList: AgentLoopBlockedToolExecution[] = [];

  for (const row of rows) {
    const { action } = row;
    const toolConfiguration = action.toolConfiguration;
    const mcpServerView = mcpServerViewByModelId.get(action.mcpServerViewId);
    const internalMCPServerName = getInternalMCPServerNameFromSId(
      toolConfiguration.toolServerId
    );
    const displayLabels =
      getToolDisplayLabels({
        internalMCPServerName,
        mcpServerName: toolConfiguration.mcpServerName,
        toolName: toolConfiguration.originalName,
        inputs: action.inputs,
      }) ?? toolConfiguration.displayLabels;

    const base = {
      messageId: row.agentMessageId,
      userId: row.userSId,
      conversationId: conversation.sId,
      actionId: action.sId,
      configurationId: row.agentConfigurationId,
      created: action.createdAt.getTime(),
      inputs: action.inputs,
      stake: toolConfiguration.permission,
      metadata: {
        toolName: toolConfiguration.originalName,
        mcpServerName: toolConfiguration.mcpServerName,
        displayLabel: displayLabels?.done,
        // Match the streaming event: function slug is not on the action row; server name is.
        agentName: toolConfiguration.mcpServerName,
        icon:
          mcpServerView?.getServerDisplayMetadata().icon ??
          toolConfiguration.icon,
        displayedAs: getInternalMCPServerDisplayedAs(
          toolConfiguration.toolServerId
        ),
      },
      argumentsRequiringApproval: toolConfiguration.argumentsRequiringApproval,
      approvalArgsLabel: await getApprovalArgsLabel({
        auth,
        internalMCPServerName,
        toolName: toolConfiguration.originalName,
        inputs: action.inputs,
        argumentsRequiringApproval:
          toolConfiguration.argumentsRequiringApproval ?? [],
        caches: approvalLabelCaches,
      }),
      sandboxFunctionId: row.sandboxFunctionId,
      invocationId: row.invocationId,
    };

    if (action.status === "blocked_validation_required") {
      blockedActionsList.push({
        ...base,
        status: "blocked_validation_required",
        authorizationInfo: null,
        // Edit+validate is not wired for sandbox-function tools yet.
        editableArguments: undefined,
      });
    } else if (action.status === "blocked_authentication_required") {
      const authorizationInfo = mcpServerView?.getAuthorization() ?? null;
      const mcpServerId = mcpServerView?.mcpServerId;
      const mcpServerDisplayName = mcpServerView?.getDisplayName();
      if (!mcpServerId || !mcpServerDisplayName || !authorizationInfo) {
        logger.warn(
          {
            actionId: action.sId,
            conversationId: conversation.sId,
            invocationId: row.invocationId,
            workspaceId: owner.sId,
          },
          "MCP server view or authorization info not found for blocked sandbox function action"
        );
        continue;
      }
      blockedActionsList.push({
        ...base,
        status: "blocked_authentication_required",
        authorizationInfo,
        metadata: {
          ...base.metadata,
          mcpServerId,
          mcpServerDisplayName,
        },
      });
    }
  }

  return blockedActionsList;
}

/**
 * Cleans up the blocked actions of an agent message that reached a terminal status
 * (interrupted, cancelled, failed, ...). The actions were already denied in the same
 * transaction as the message's terminal status update; post-commit side effects happen here.
 */
export async function cleanupDeniedBlockedActions(
  auth: Authenticator,
  {
    conversation,
    agentMessage,
    deniedActions,
  }: {
    conversation: ConversationWithoutContentType;
    agentMessage: Pick<AgentMessageType, "agentMessageId" | "sId">;
    deniedActions: AgentMCPActionResource[];
  }
): Promise<void> {
  if (deniedActions.length > 0) {
    emitApprovalResolvedAuditEvents(auth, {
      conversation,
      agentMessage,
      deniedActions,
    });

    logger.info(
      {
        actionIds: deniedActions.map((a) => a.sId),
        conversationId: conversation.sId,
        messageId: agentMessage.sId,
        workspaceId: auth.getNonNullableWorkspace().sId,
      },
      "Denied blocked actions of terminated agent message"
    );

    // Remove the pending blocked-action events (approval requests, auth requests, user
    // questions) from the message channel so live clients stop surfacing prompts for them.
    const deniedActionIds = new Set(deniedActions.map((a) => a.sId));
    await getRedisHybridManager().removeEvent((event) => {
      const payload = JSON.parse(event.message["payload"]);
      return (
        isBlockedActionEvent(payload) && deniedActionIds.has(payload.actionId)
      );
    }, getMessageChannelId(agentMessage.sId));
  }

  // Always re-check the flag, even when no blocked action remains: a partial previous run may
  // have denied the actions but failed before clearing it, and a retry must converge.
  await clearActionRequiredIfNoBlockedActions(auth, {
    conversationId: conversation.sId,
  });
}

/**
 * Emits a `tool.approval_resolved` audit event for each manual approval that was auto-denied
 * when its agent message terminated, so the audit trail doesn't keep `tool.approval_requested`
 * entries without a resolution. Fire-and-forget (audit-security-sensitive-mutations): must never
 * block or break the
 * termination flow.
 */
function emitApprovalResolvedAuditEvents(
  auth: Authenticator,
  {
    conversation,
    agentMessage,
    deniedActions,
  }: {
    conversation: ConversationWithoutContentType;
    agentMessage: Pick<AgentMessageType, "agentMessageId" | "sId">;
    deniedActions: AgentMCPActionResource[];
  }
): void {
  // `deniedActions` are resources fetched before the transaction updates their rows, so their
  // in-memory status still identifies which blocked state they had before being denied.
  const deniedApprovals = deniedActions.filter(
    (a) => a.status === "blocked_validation_required"
  );
  if (deniedApprovals.length === 0) {
    return;
  }

  void (async () => {
    try {
      // All blocked actions belong to the same agent message, so resolve the agent
      // configuration once.
      const auditAgent = await deniedApprovals[0].getAgent(auth);
      const workspace = auth.getNonNullableWorkspace();
      for (const action of deniedApprovals) {
        void emitAuditLogEventDirect({
          workspace,
          action: "tool.approval_resolved",
          // Auto-denial is a mechanical termination cleanup, not a user approval decision.
          actor: {
            type: "system",
            id: "agent-message-termination",
            name: "Agent message termination",
          },
          // The agent travels in metadata: frame function tool calls share this action
          // and have no agent.
          targets: [
            buildAuditLogTarget("workspace", workspace),
            buildAuditLogTarget("tool", {
              sId: action.toolConfiguration.name,
              name: action.toolConfiguration.originalName,
            }),
          ],
          context: { location: "internal" },
          metadata: {
            // Distinct from the user decisions ("approved", "rejected", ...): the approval was
            // resolved by the system because the message terminated, not by an explicit user
            // choice.
            decision: "auto_rejected",
            tool_name: action.toolConfiguration.originalName,
            mcp_server_name: action.toolConfiguration.mcpServerName,
            stake_level: action.toolConfiguration.permission,
            ...(auditAgent
              ? {
                  agent_id: auditAgent.sId,
                  agent_name: auditAgent.name,
                }
              : {}),
            conversation_id: conversation.sId,
            agent_message_id: agentMessage.sId,
            action_id: action.sId,
            deciding_user_id: "system",
            deciding_user_email: "system",
          },
        });
      }
    } catch (err) {
      logger.error(
        {
          err: normalizeError(err),
          conversationId: conversation.sId,
          messageId: agentMessage.sId,
        },
        "Failed to emit tool.approval_resolved audit events for terminated message"
      );
    }
  })();
}

/**
 * Clears the participants' `actionRequired` flag of a conversation if no blocked action remains.
 * The flag is denormalized (set when a tool starts waiting on user input, cleared when an agent
 * loop is launched), so it can go stale when a blocked message is terminated without its blocked
 * actions being resolved.
 */
export async function clearActionRequiredIfNoBlockedActions(
  auth: Authenticator,
  { conversationId }: { conversationId: string }
): Promise<void> {
  const conversation = await ConversationResource.fetchById(
    auth,
    conversationId
  );
  if (!conversation) {
    return;
  }

  const blockedActions = await listConversationBlockedActions(
    auth,
    conversation
  );

  if (blockedActions.length === 0) {
    await ConversationResource.clearActionRequiredForConversation(
      auth,
      conversation
    );
  }
}
