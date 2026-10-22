import { createHash } from "node:crypto";
import type { InferenceHookExecutionRef } from "@app/lib/inference_hook";

/**
 * @cc [owner:frankaloia,label:concurrency;product] inference-hook-workflow-id
 * The workflow ID MUST be a deterministic function of the hook ID and every checkpoint field, so
 * repeated starts for one checkpoint resolve to a single execution and distinct checkpoints never
 * share one.
 */
export function makeInferenceHookWorkflowId({
  hookId,
  checkpoint,
}: InferenceHookExecutionRef): string {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        hookId,
        checkpoint.workspaceId,
        checkpoint.conversationId,
        checkpoint.agentMessageId,
        checkpoint.agentMessageVersion,
        checkpoint.step,
        checkpoint.lifecycleEvent,
        checkpoint.lifecycleEvent === "after_model_call"
          ? checkpoint.dustRunId
          : null,
      ])
    )
    .digest("hex");
  return `inference-hook-${checkpoint.workspaceId}-${hash}`;
}
