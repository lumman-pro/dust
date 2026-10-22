import type { AuthenticatorType } from "@app/lib/auth";
import type {
  InferenceHookExecutionRef,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import type * as activities from "@app/temporal/inference_hooks/activities";
import { proxyActivities } from "@temporalio/workflow";

const { evaluateInferenceHookActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  retry: {
    maximumAttempts: 3,
  },
});

export async function evaluateInferenceHookWorkflow(
  authType: AuthenticatorType,
  execution: InferenceHookExecutionRef
): Promise<InferenceHookVerdict> {
  return evaluateInferenceHookActivity(authType, execution);
}
