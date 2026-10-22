import type { ActionApprovalStateType } from "@app/lib/actions/mcp";
import { resolveSandboxFunctionActionAuthentication } from "@app/lib/api/sandbox_functions/resolve_authentication";
import { validateSandboxFunctionAction } from "@app/lib/api/sandbox_functions/validate_action";
import type { Authenticator } from "@app/lib/auth";
import { DustError } from "@app/lib/error";
import type { ConversationResource } from "@app/lib/resources/conversation_resource";
import { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import { SandboxFunctionResource } from "@app/lib/resources/sandbox_function_resource";
import { isResourceSId } from "@app/lib/resources/string_ids";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

async function loadConversationLinkedSandboxAction(
  auth: Authenticator,
  {
    actionId,
    conversation,
    messageId,
  }: {
    actionId: string;
    conversation: ConversationResource;
    messageId: string;
  }
): Promise<
  | {
      action: SandboxFunctionMCPActionResource;
      invocation: SandboxFunctionInvocationResource;
    }
  | { error: DustError }
> {
  if (!isResourceSId("sandbox_function_mcp_action", actionId)) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  const action = await SandboxFunctionMCPActionResource.fetchById(
    auth,
    actionId
  );
  if (!action) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  const ids = await action.getFunctionAndInvocationSIds(auth);
  if (!ids) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  const sandboxFunction =
    await SandboxFunctionResource.fetchByIdForInvocationResolution(
      auth,
      ids.sandboxFunctionId
    );
  if (!sandboxFunction) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  // System access: conversation authz already ran; initiator check happens in the sandbox helpers.
  const invocation = await SandboxFunctionInvocationResource.fetchById(auth, {
    sandboxFunction,
    invocationId: ids.invocationId,
    access: "system",
  });
  if (!invocation || action.invocationId !== invocation.sId) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  const conversationCaller = (await invocation.getContext())
    ?.conversationCaller;
  if (
    !conversationCaller ||
    conversationCaller.conversationId !== conversation.sId ||
    conversationCaller.agentMessageId !== messageId
  ) {
    return {
      error: new DustError("action_not_found", `Action not found: ${actionId}`),
    };
  }

  return { action, invocation };
}

function mapSandboxResolutionError(
  type: "action_not_found" | "action_not_blocked" | "unauthorized",
  message: string
): DustError {
  return new DustError(type, message);
}

/**
 * Conversation validate-action entry for `sfa_` ids (SDK/CLI clients that only know the
 * conversation endpoint).
 */
export async function validateSandboxFunctionActionFromConversation(
  auth: Authenticator,
  conversation: ConversationResource,
  {
    actionId,
    approvalState,
    messageId,
  }: {
    actionId: string;
    approvalState: ActionApprovalStateType;
    messageId: string;
  }
): Promise<Result<void, DustError>> {
  const loaded = await loadConversationLinkedSandboxAction(auth, {
    actionId,
    conversation,
    messageId,
  });
  if ("error" in loaded) {
    return new Err(loaded.error);
  }

  const result = await validateSandboxFunctionAction(auth, {
    sandboxFunction: loaded.invocation.sandboxFunction,
    invocationId: loaded.invocation.sId,
    actionId: loaded.action.sId,
    approvalState,
  });
  if (result.isErr()) {
    return new Err(
      mapSandboxResolutionError(result.error.type, result.error.message)
    );
  }
  return new Ok(undefined);
}

/**
 * Conversation resolve-authentication entry for `sfa_` ids.
 */
export async function resolveSandboxFunctionAuthenticationFromConversation(
  auth: Authenticator,
  conversation: ConversationResource,
  {
    actionId,
    messageId,
    outcome,
  }: {
    actionId: string;
    messageId: string;
    outcome: "completed" | "denied";
  }
): Promise<Result<void, DustError>> {
  const loaded = await loadConversationLinkedSandboxAction(auth, {
    actionId,
    conversation,
    messageId,
  });
  if ("error" in loaded) {
    return new Err(loaded.error);
  }

  const result = await resolveSandboxFunctionActionAuthentication(auth, {
    sandboxFunction: loaded.invocation.sandboxFunction,
    invocationId: loaded.invocation.sId,
    actionId: loaded.action.sId,
    outcome,
  });
  if (result.isErr()) {
    return new Err(
      mapSandboxResolutionError(result.error.type, result.error.message)
    );
  }
  return new Ok(undefined);
}
