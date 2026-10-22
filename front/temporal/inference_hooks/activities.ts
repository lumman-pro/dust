import type { AuthenticatorType } from "@app/lib/auth";
import { Authenticator } from "@app/lib/auth";
import { isDustErrorWithCode } from "@app/lib/error";
import type {
  InferenceHookExecutionRef,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import { evaluateInferenceHookAtCheckpoint } from "@app/lib/inference_hook/checkpoint_evaluation";
import logger from "@app/logger/logger";
import { ApplicationFailure } from "@temporalio/common";

// TODO(inference-hooks tasks#11315): Record verdicts and errors in inference_hook_executions.
/**
 * @cc [owner:frankaloia,label:error-handling] unavailable-checkpoint-fails-without-retry
 * When the checkpoint input is unavailable (`inference_hook_checkpoint_unavailable`), the activity
 * MUST fail with a non-retryable failure. Other errors MUST remain retryable.
 */
export async function evaluateInferenceHookActivity(
  authType: AuthenticatorType,
  execution: InferenceHookExecutionRef
): Promise<InferenceHookVerdict> {
  const auth = await Authenticator.fromJSON(authType);

  const result = await evaluateInferenceHookAtCheckpoint(auth, execution);
  if (result.isErr()) {
    if (
      isDustErrorWithCode(result.error, "inference_hook_checkpoint_unavailable")
    ) {
      throw ApplicationFailure.nonRetryable(
        result.error.message,
        result.error.code
      );
    }
    throw result.error;
  }

  logger.info(
    {
      hookId: execution.hookId,
      ...execution.checkpoint,
      verdict: result.value,
    },
    "Inference hook workflow evaluated"
  );
  return result.value;
}
