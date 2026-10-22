import type { AuthenticatorType } from "@app/lib/auth";
import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";
import { getTemporalClientForFrontNamespace } from "@app/lib/temporal";
import { concurrentExecutor } from "@app/lib/utils/async_utils";
import logger from "@app/logger/logger";
import { QUEUE_NAME } from "@app/temporal/inference_hooks/config";
import { makeInferenceHookWorkflowId } from "@app/temporal/inference_hooks/helpers";
import { evaluateInferenceHookWorkflow } from "@app/temporal/inference_hooks/workflows";
import type { WhitelistableFeature } from "@app/types/shared/feature_flags";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { WorkflowIdConflictPolicy } from "@temporalio/common";

const INFERENCE_HOOK_WORKFLOW_LAUNCH_CONCURRENCY = 8;

/**
 * @cc [owner:frankaloia,label:product;performance] inference-hook-workflows-do-not-affect-run
 * When `featureFlags` excludes `inference_hooks` or `hookIds` is empty, no workflow MUST be
 * started. Otherwise one workflow MUST be started per hook for `checkpoint`. The caller MUST NOT
 * wait for provider results, and launch failures MUST be logged without throwing.
 */
export async function launchInferenceHookWorkflows({
  authType,
  featureFlags,
  hookIds,
  checkpoint,
}: {
  authType: AuthenticatorType;
  featureFlags: readonly WhitelistableFeature[];
  hookIds: readonly string[];
  checkpoint: InferenceHookCheckpointRef;
}): Promise<void> {
  if (!featureFlags.includes("inference_hooks") || hookIds.length === 0) {
    return;
  }

  await concurrentExecutor(
    hookIds,
    async (hookId) => {
      const workflowId = makeInferenceHookWorkflowId({
        hookId,
        checkpoint,
      });
      try {
        const client = await getTemporalClientForFrontNamespace();
        await client.workflow.start(evaluateInferenceHookWorkflow, {
          args: [authType, { hookId, checkpoint }],
          taskQueue: QUEUE_NAME,
          workflowId,
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
          memo: {
            hookId,
            agentMessageId: checkpoint.agentMessageId,
            workspaceId: checkpoint.workspaceId,
          },
        });
      } catch (e) {
        if (e instanceof WorkflowExecutionAlreadyStartedError) {
          return;
        }
        logger.error(
          { workflowId, hookId, ...checkpoint, error: e },
          "Failed starting inference hook workflow"
        );
      }
    },
    { concurrency: INFERENCE_HOOK_WORKFLOW_LAUNCH_CONCURRENCY }
  );
}
