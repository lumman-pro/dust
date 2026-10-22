import type { AuthenticatorType } from "@app/lib/auth";
import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";
import { getTemporalClientForFrontNamespace } from "@app/lib/temporal";
import logger from "@app/logger/logger";
import { launchInferenceHookWorkflows } from "@app/temporal/inference_hooks/client";
import { makeInferenceHookWorkflowId } from "@app/temporal/inference_hooks/helpers";
import { evaluateInferenceHookWorkflow } from "@app/temporal/inference_hooks/workflows";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
} from "@temporalio/client";
import { WorkflowIdConflictPolicy } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const beforeCheckpoint: InferenceHookCheckpointRef = {
  lifecycleEvent: "before_model_call",
  workspaceId: "w1",
  conversationId: "c1",
  agentMessageId: "m1",
  agentMessageVersion: 0,
  step: 0,
};

const afterCheckpoint: InferenceHookCheckpointRef = {
  ...beforeCheckpoint,
  lifecycleEvent: "after_model_call",
  dustRunId: "run_1",
};

describe("makeInferenceHookWorkflowId", () => {
  it("is stable for the same hook and checkpoint", () => {
    expect(
      makeInferenceHookWorkflowId({
        hookId: "hook_a",
        checkpoint: afterCheckpoint,
      })
    ).toBe(
      makeInferenceHookWorkflowId({
        hookId: "hook_a",
        checkpoint: { ...afterCheckpoint },
      })
    );
  });

  it("differs when any hook or checkpoint field differs", () => {
    const workflowIds = [
      { hookId: "hook_a", checkpoint: beforeCheckpoint },
      { hookId: "hook_b", checkpoint: beforeCheckpoint },
      { hookId: "hook_a", checkpoint: afterCheckpoint },
      {
        hookId: "hook_a",
        checkpoint: { ...afterCheckpoint, dustRunId: "run_2" },
      },
      { hookId: "hook_a", checkpoint: { ...beforeCheckpoint, step: 1 } },
      {
        hookId: "hook_a",
        checkpoint: { ...beforeCheckpoint, agentMessageVersion: 1 },
      },
      {
        hookId: "hook_a",
        checkpoint: { ...beforeCheckpoint, agentMessageId: "m2" },
      },
      {
        hookId: "hook_a",
        checkpoint: { ...beforeCheckpoint, conversationId: "c2" },
      },
      {
        hookId: "hook_a",
        checkpoint: { ...beforeCheckpoint, workspaceId: "w2" },
      },
    ].map(makeInferenceHookWorkflowId);

    expect(new Set(workflowIds).size).toBe(workflowIds.length);
  });
});

// Fixture setup logs unrelated errors asynchronously, so assertions match this message only.
const LAUNCH_FAILED_MESSAGE = "Failed starting inference hook workflow";

async function getWorkflowStartMock() {
  const client = await getTemporalClientForFrontNamespace();
  return vi.mocked(client.workflow.start);
}

describe("launchInferenceHookWorkflows", () => {
  let authType: AuthenticatorType;
  let mockWorkflowStart: Awaited<ReturnType<typeof getWorkflowStartMock>>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const { authenticator } = await createResourceTest({ role: "admin" });
    authType = authenticator.toJSON();
    mockWorkflowStart = await getWorkflowStartMock();
  });

  it("starts no workflow when the feature flag is off", async () => {
    await launchInferenceHookWorkflows({
      authType,
      featureFlags: [],
      hookIds: ["hook_a"],
      checkpoint: beforeCheckpoint,
    });

    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("starts no workflow when no hooks are configured", async () => {
    await launchInferenceHookWorkflows({
      authType,
      featureFlags: ["inference_hooks"],
      hookIds: [],
      checkpoint: beforeCheckpoint,
    });

    expect(mockWorkflowStart).not.toHaveBeenCalled();
  });

  it("starts one deduplicated workflow per hook", async () => {
    await launchInferenceHookWorkflows({
      authType,
      featureFlags: ["inference_hooks"],
      hookIds: ["hook_a", "hook_b"],
      checkpoint: afterCheckpoint,
    });

    expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
    for (const hookId of ["hook_a", "hook_b"]) {
      expect(mockWorkflowStart).toHaveBeenCalledWith(
        evaluateInferenceHookWorkflow,
        expect.objectContaining({
          args: [authType, { hookId, checkpoint: afterCheckpoint }],
          workflowId: makeInferenceHookWorkflowId({
            hookId,
            checkpoint: afterCheckpoint,
          }),
          workflowIdConflictPolicy: WorkflowIdConflictPolicy.USE_EXISTING,
          workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
        })
      );
    }
  });

  it("treats an already started workflow as launched", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    mockWorkflowStart.mockRejectedValueOnce(
      new WorkflowExecutionAlreadyStartedError(
        "already started",
        "workflow-id",
        "evaluateInferenceHookWorkflow"
      )
    );

    await launchInferenceHookWorkflows({
      authType,
      featureFlags: ["inference_hooks"],
      hookIds: ["hook_a"],
      checkpoint: beforeCheckpoint,
    });

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      LAUNCH_FAILED_MESSAGE
    );
  });

  it("logs launch failures without throwing and still launches other hooks", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    mockWorkflowStart.mockRejectedValueOnce(new Error("Temporal unavailable"));

    await expect(
      launchInferenceHookWorkflows({
        authType,
        featureFlags: ["inference_hooks"],
        hookIds: ["hook_a", "hook_b"],
        checkpoint: beforeCheckpoint,
      })
    ).resolves.toBeUndefined();

    expect(mockWorkflowStart).toHaveBeenCalledTimes(2);
    expect(
      errorSpy.mock.calls.filter((call) => call.includes(LAUNCH_FAILED_MESSAGE))
    ).toHaveLength(1);
  });
});
