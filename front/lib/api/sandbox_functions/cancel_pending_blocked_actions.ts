import { isBlockedActionEvent } from "@app/lib/actions/mcp";
import { clearActionRequiredIfNoBlockedActions } from "@app/lib/api/assistant/conversation/blocked_actions";
import { getRedisHybridManager } from "@app/lib/api/redis-hybrid-manager";
import { getSandboxFunctionBlockingEventChannel } from "@app/lib/api/sandbox_functions/publish_blocking_event";
import type { Authenticator } from "@app/lib/auth";
import type { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import logger from "@app/logger/logger";

/**
 * Denies any still-blocked tools on an invocation and drops their Redis events.
 * Used when the caller gives up (e.g. `callSandboxFunction` wait timeout) so the conversation
 * card cannot be approved after the function is already gone.
 */
export async function cancelPendingSandboxFunctionBlockedActions(
  auth: Authenticator,
  invocation: SandboxFunctionInvocationResource
): Promise<void> {
  const blockedActions =
    await SandboxFunctionMCPActionResource.listBlockedByInvocation(
      auth,
      invocation
    );
  if (blockedActions.length === 0) {
    return;
  }

  const deniedActionIds: string[] = [];
  for (const action of blockedActions) {
    if (
      action.status !== "blocked_validation_required" &&
      action.status !== "blocked_authentication_required"
    ) {
      continue;
    }
    const [updatedCount] = await action.updateStatusFromExpected(auth, {
      status: "denied",
      expectedStatus: action.status,
    });
    if (updatedCount > 0) {
      deniedActionIds.push(action.sId);
    }
  }

  if (deniedActionIds.length === 0) {
    return;
  }

  const deniedActionIdSet = new Set(deniedActionIds);
  await getRedisHybridManager().removeEvent(
    (event) => {
      const payload = JSON.parse(event.message["payload"]);
      return (
        isBlockedActionEvent(payload) && deniedActionIdSet.has(payload.actionId)
      );
    },
    await getSandboxFunctionBlockingEventChannel(invocation)
  );

  logger.info(
    {
      workspaceId: auth.getNonNullableWorkspace().sId,
      sandboxFunctionId: invocation.sandboxFunction.sId,
      invocationId: invocation.sId,
      actionIds: deniedActionIds,
    },
    "Cancelled pending sandbox function blocked actions after caller abandoned the wait"
  );

  const conversationCaller = (await invocation.getContext())
    ?.conversationCaller;
  if (conversationCaller) {
    await clearActionRequiredIfNoBlockedActions(auth, {
      conversationId: conversationCaller.conversationId,
    });
  }
}
