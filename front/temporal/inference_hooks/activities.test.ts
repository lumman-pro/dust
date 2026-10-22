import type { AuthenticatorType } from "@app/lib/auth";
import { DustError } from "@app/lib/error";
import type { InferenceHookExecutionRef } from "@app/lib/inference_hook";
import * as checkpointEvaluation from "@app/lib/inference_hook/checkpoint_evaluation";
import { evaluateInferenceHookActivity } from "@app/temporal/inference_hooks/activities";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { Err } from "@app/types/shared/result";
import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("evaluateInferenceHookActivity", () => {
  let authType: AuthenticatorType;
  let execution: InferenceHookExecutionRef;

  beforeEach(async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });
    authType = authenticator.toJSON();
    execution = {
      hookId: "hook",
      checkpoint: {
        lifecycleEvent: "before_model_call",
        workspaceId: workspace.sId,
        conversationId: "conversation",
        agentMessageId: "message",
        agentMessageVersion: 0,
        step: 0,
      },
    };
  });

  it("fails without retry when the checkpoint is unavailable", async () => {
    vi.spyOn(
      checkpointEvaluation,
      "evaluateInferenceHookAtCheckpoint"
    ).mockResolvedValue(
      new Err(new DustError("inference_hook_checkpoint_unavailable", "missing"))
    );

    const error = await evaluateInferenceHookActivity(
      authType,
      execution
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApplicationFailure);
    expect(error).toMatchObject({
      nonRetryable: true,
      type: "inference_hook_checkpoint_unavailable",
    });
  });

  it("keeps other errors retryable", async () => {
    vi.spyOn(
      checkpointEvaluation,
      "evaluateInferenceHookAtCheckpoint"
    ).mockResolvedValue(new Err(new Error("Unknown inference hook: hook")));

    const error = await evaluateInferenceHookActivity(
      authType,
      execution
    ).catch((e: unknown) => e);

    expect(error).not.toBeInstanceOf(ApplicationFailure);
    expect(error).toBeInstanceOf(Error);
  });
});
