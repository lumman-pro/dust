import type { Authenticator } from "@app/lib/auth";
import type {
  InferenceHookExecutionRef,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import { evaluateInferenceHookProvider } from "@app/lib/inference_hook";
import { loadInferenceHookInputFromCheckpoint } from "@app/lib/inference_hook/checkpoint_input";
import { getInferenceHook } from "@app/lib/inference_hook/registry";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";

/**
 * @cc [owner:frankaloia,label:product] inference-hook-evaluates-checkpoint
 * A monitored hook MUST evaluate the input loaded for `checkpoint`, under its own `timeoutMs`.
 * A timeout or provider failure MUST be returned as an error, never as a verdict.
 */
export async function evaluateInferenceHookAtCheckpoint(
  auth: Authenticator,
  { hookId, checkpoint }: InferenceHookExecutionRef
): Promise<Result<InferenceHookVerdict, Error>> {
  const hook = getInferenceHook(hookId);
  if (!hook) {
    return new Err(new Error(`Unknown inference hook: ${hookId}`));
  }

  const inputRes = await loadInferenceHookInputFromCheckpoint(auth, checkpoint);
  if (inputRes.isErr()) {
    return inputRes;
  }

  return evaluateInferenceHookProvider(
    hook.provider,
    inputRes.value,
    AbortSignal.timeout(hook.timeoutMs)
  );
}
