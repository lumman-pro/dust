import type {
  SandboxFunctionMCPApproveExecutionEvent,
  SandboxFunctionToolPersonalAuthRequiredEvent,
} from "@app/lib/actions/mcp_internal_actions/events";
import { publishEvent } from "@app/lib/api/assistant/streaming/events";
import { getMessageChannelId } from "@app/lib/api/assistant/streaming/helpers";
import {
  getSandboxFunctionInvocationChannelId,
  publishSandboxFunctionInvocationEvent,
} from "@app/lib/api/sandbox_functions/events";
import type { Authenticator } from "@app/lib/auth";
import { notifyManualActionRequired } from "@app/lib/notifications/triggers/manual-action-required";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import type { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import type { SandboxFunctionConversationCaller } from "@app/types/api/sandbox_functions";

// Blocking events that today publish through the sandbox-function invocation stream (and may be
// rerouted to a conversation message channel). Keep this aligned with
// `SandboxFunctionInvocationEvent`.
export type SandboxFunctionBlockingEvent =
  | SandboxFunctionMCPApproveExecutionEvent
  | SandboxFunctionToolPersonalAuthRequiredEvent;

/**
 * Channel that holds a pending blocking event for this invocation (approval / auth / ask-user).
 * Conversation-originated invocations publish to the agent message channel; others use the
 * invocation SSE stream.
 */
export async function getSandboxFunctionBlockingEventChannel(
  invocation: SandboxFunctionInvocationResource
): Promise<string> {
  const conversationCaller = (await invocation.getContext())
    ?.conversationCaller;
  if (conversationCaller) {
    return getMessageChannelId(conversationCaller.agentMessageId);
  }
  return getSandboxFunctionInvocationChannelId({
    invocationId: invocation.sId,
  });
}

/**
 * Publish a user-blocking sandbox-function event to the surface that can show a card:
 * conversation message channel when `conversationCaller` is set, otherwise invocation SSE.
 */
export async function publishSandboxFunctionBlockingEvent(
  auth: Authenticator,
  event: SandboxFunctionBlockingEvent,
  {
    invocation,
  }: {
    invocation: SandboxFunctionInvocationResource;
  }
): Promise<void> {
  const conversationCaller = (await invocation.getContext())
    ?.conversationCaller;
  if (!conversationCaller) {
    await publishSandboxFunctionInvocationEvent(event, {
      invocationId: invocation.sId,
    });
    return;
  }

  await publishBlockingEventToConversation(auth, event, conversationCaller);
}

async function publishBlockingEventToConversation(
  auth: Authenticator,
  event: SandboxFunctionBlockingEvent,
  conversationCaller: SandboxFunctionConversationCaller
): Promise<void> {
  const bridgedEvent = {
    ...event,
    conversationId: conversationCaller.conversationId,
    messageId: conversationCaller.agentMessageId,
    configurationId: conversationCaller.configurationId,
  };

  // Match agent-loop message events: clients expect a `step` field on the payload.
  await publishEvent({
    origin: "user_message_events",
    channel: getMessageChannelId(conversationCaller.agentMessageId),
    event: JSON.stringify({ ...bridgedEvent, step: 0 }),
  });

  const conversation = await ConversationResource.fetchById(
    auth,
    conversationCaller.conversationId
  );
  if (!conversation) {
    return;
  }

  const markResult = await ConversationResource.markAsActionRequired(auth, {
    conversation,
  });
  // Notify only when we flipped the flag (same idea as createSandboxChildAction).
  if (markResult.isOk() && markResult.value[0] > 0) {
    notifyManualActionRequired(auth, {
      conversationId: conversationCaller.conversationId,
      actionId: event.actionId,
    });
  }
}
