import { isFreeUsageBlocked } from "@app/lib/api/llm/free_usage";
import { getLlmCredentials } from "@app/lib/api/provider_credentials";
import { DurationRecorder } from "@app/lib/duration_recorder";
import { AgentMessageModel } from "@app/lib/models/agent/conversation";
import { AgentMCPActionResource } from "@app/lib/resources/agent_mcp_action_resource";
import { AgentStepContentResource } from "@app/lib/resources/agent_step_content_resource";
import { getOutputFromLLMStream } from "@app/temporal/agent_loop/lib/get_output_from_llm";
import { runModel } from "@app/temporal/agent_loop/lib/run_model";
import { launchInferenceHookWorkflows } from "@app/temporal/inference_hooks/client";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { InferenceHookProviderFactory } from "@app/tests/utils/InferenceHookProviderFactory";
import { InferenceHookRunModelFactory } from "@app/tests/utils/InferenceHookRunModelFactory";
import { Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

const shutdownMock = vi.hoisted(() => ({ controller: new AbortController() }));

vi.mock("@app/lib/shutdown_signal", () => ({
  DUST_WORKER_SHUTDOWN_ABORT_REASON: "DUST_WORKER_SHUTDOWN_ABORT",
  getShutdownSignal: () => shutdownMock.controller.signal,
}));

vi.mock("@app/lib/api/llm/free_usage", () => ({
  isFreeUsageBlocked: vi.fn(),
}));

vi.mock("@app/lib/api/provider_credentials", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@app/lib/api/provider_credentials")
  >()),
  getLlmCredentials: vi.fn(),
}));

vi.mock("@app/temporal/agent_loop/lib/get_output_from_llm", () => ({
  getOutputFromLLMStream: vi.fn(),
}));

vi.mock("@app/temporal/inference_hooks/client", () => ({
  launchInferenceHookWorkflows: vi.fn(),
}));

vi.mock("@langfuse/tracing", () => ({
  startActiveObservation: vi.fn(
    async (_name: string, callback: () => Promise<unknown>) => callback()
  ),
}));

vi.mock("@temporalio/activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@temporalio/activity")>()),
  Context: {
    current: () => ({
      info: { attempt: 1 },
      cancellationSignal: new AbortController().signal,
    }),
  },
  heartbeat: vi.fn(),
}));

describe("runModel inference hooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shutdownMock.controller = new AbortController();
    vi.mocked(getLlmCredentials).mockResolvedValue({});
    vi.mocked(isFreeUsageBlocked).mockResolvedValue(false);
  });

  it("does not dispatch the model when BeforeModelCall denies", async () => {
    const { auth, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    const provider = InferenceHookProviderFactory.deny("Blocked before model");

    const result = await runModel(auth, {
      contextProvider,
      runIds: [],
      step: 0,
      functionCallStepContentIds: {},
      durationRecorder: DurationRecorder.create(),
      activityTimeoutDeadlineMs: Date.now() + 60_000,
      enforcedInferenceHooks: [InferenceHookProviderFactory.enforced(provider)],
    });

    expect(result).toBeNull();
    expect(getOutputFromLLMStream).not.toHaveBeenCalled();
    expect(provider.inputs.map((input) => input.lifecycleEvent)).toEqual([
      "before_model_call",
    ]);
  });

  it("throws a retryable interruption when the worker shuts down during BeforeModelCall", async () => {
    const { auth, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    const provider = InferenceHookProviderFactory.custom(
      async (_input, { signal }) => {
        shutdownMock.controller.abort("DUST_WORKER_SHUTDOWN_ABORT");
        return new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        });
      }
    );

    await expect(
      runModel(auth, {
        contextProvider,
        runIds: [],
        step: 0,
        functionCallStepContentIds: {},
        durationRecorder: DurationRecorder.create(),
        activityTimeoutDeadlineMs: Date.now() + 60_000,
        enforcedInferenceHooks: [
          InferenceHookProviderFactory.enforced(provider),
        ],
      })
    ).rejects.toMatchObject({ type: "ModelInterruption", nonRetryable: false });
    expect(getOutputFromLLMStream).not.toHaveBeenCalled();
  });

  it("throws a retryable interruption when the worker shuts down during AfterModelCall", async () => {
    const { auth, agentMessage, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    const provider = InferenceHookProviderFactory.custom(async (input) => {
      if (input.lifecycleEvent === "after_model_call") {
        shutdownMock.controller.abort("DUST_WORKER_SHUTDOWN_ABORT");
      }
      return { action: "allow" };
    });
    vi.mocked(getOutputFromLLMStream).mockResolvedValue(
      new Ok({
        output: {
          actions: [],
          generation: "Hello",
          contents: [{ type: "text_content", value: "Hello" }],
        },
        dustRunId: "dust_run_1",
        nativeChainOfThought: "",
      })
    );

    await expect(
      runModel(auth, {
        contextProvider,
        runIds: [],
        step: 0,
        functionCallStepContentIds: {},
        durationRecorder: DurationRecorder.create(),
        activityTimeoutDeadlineMs: Date.now() + 60_000,
        enforcedInferenceHooks: [
          InferenceHookProviderFactory.enforced(provider),
        ],
      })
    ).rejects.toMatchObject({ type: "ModelInterruption", nonRetryable: false });

    const stepContents =
      await AgentStepContentResource.fetchByAgentMessageModelIdsAtStep(auth, {
        agentMessageModelIds: [agentMessage.agentMessageId],
        step: 0,
      });
    expect(stepContents).toEqual([]);
  });

  it("persists only the error and creates no actions when AfterModelCall denies", async () => {
    const { auth, agentMessage, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    const provider = InferenceHookProviderFactory.custom(async (input) =>
      input.lifecycleEvent === "before_model_call"
        ? { action: "allow" }
        : { action: "deny", reason: "Blocked after model" }
    );
    vi.mocked(getOutputFromLLMStream).mockResolvedValue(
      new Ok({
        output: {
          actions: [{ functionCallId: "call_1", name: "test_tool" }],
          generation: null,
          contents: [
            {
              type: "function_call",
              value: {
                id: "call_1",
                name: "test_tool",
                arguments: "{}",
              },
            },
          ],
        },
        dustRunId: "dust_run_1",
        nativeChainOfThought: "",
      })
    );

    const result = await runModel(auth, {
      contextProvider,
      runIds: [],
      step: 0,
      functionCallStepContentIds: {},
      durationRecorder: DurationRecorder.create(),
      activityTimeoutDeadlineMs: Date.now() + 60_000,
      enforcedInferenceHooks: [InferenceHookProviderFactory.enforced(provider)],
    });

    const stepContents =
      await AgentStepContentResource.fetchByAgentMessageModelIdsAtStep(auth, {
        agentMessageModelIds: [agentMessage.agentMessageId],
        step: 0,
      });
    const nextStepContents =
      await AgentStepContentResource.fetchByAgentMessageModelIdsAtStep(auth, {
        agentMessageModelIds: [agentMessage.agentMessageId],
        step: 1,
      });
    const actions = await AgentMCPActionResource.listByAgentMessageIds(auth, [
      agentMessage.agentMessageId,
    ]);

    expect(result).toBeNull();
    expect(getOutputFromLLMStream).toHaveBeenCalledTimes(1);
    expect(provider.inputs.map((input) => input.lifecycleEvent)).toEqual([
      "before_model_call",
      "after_model_call",
    ]);
    for (const input of provider.inputs) {
      expect(input.agentConfiguration).not.toHaveProperty("instructions");
      expect(input.agentConfiguration).not.toHaveProperty("instructionsHtml");
    }
    expect(stepContents).toHaveLength(1);
    expect(stepContents[0].value).toMatchObject({
      type: "error",
      value: {
        code: "inference_hook_denied",
        message: "Blocked after model",
        metadata: { category: "hook_blocked" },
      },
    });
    expect(nextStepContents).toEqual([]);
    expect(actions).toEqual([]);
  });

  it("launches monitored hook workflows for both checkpoints of the current step", async () => {
    const { auth, agentMessage, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    vi.mocked(getOutputFromLLMStream).mockResolvedValue(
      new Ok({
        output: {
          actions: [],
          generation: "Hello",
          contents: [{ type: "text_content", value: "Hello" }],
        },
        dustRunId: "dust_run_1",
        nativeChainOfThought: "",
      })
    );

    await runModel(auth, {
      contextProvider,
      runIds: [],
      step: 0,
      functionCallStepContentIds: {},
      durationRecorder: DurationRecorder.create(),
      activityTimeoutDeadlineMs: Date.now() + 60_000,
      monitoredInferenceHookIds: ["hook_a"],
    });

    const checkpointIdentity = {
      workspaceId: auth.getNonNullableWorkspace().sId,
      conversationId: contextProvider.runtimeData.conversation.sId,
      agentMessageId: agentMessage.sId,
      agentMessageVersion: agentMessage.version,
      step: 0,
    };
    expect(
      vi
        .mocked(launchInferenceHookWorkflows)
        .mock.calls.map(([args]) => args.checkpoint)
    ).toEqual([
      { ...checkpointIdentity, lifecycleEvent: "before_model_call" },
      {
        ...checkpointIdentity,
        lifecycleEvent: "after_model_call",
        dustRunId: "dust_run_1",
      },
    ]);
    expect(launchInferenceHookWorkflows).toHaveBeenCalledWith(
      expect.objectContaining({ hookIds: ["hook_a"] })
    );
  });

  it("does not launch monitored hook workflows for a checkpoint an enforced hook denied", async () => {
    const { auth, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");

    await runModel(auth, {
      contextProvider,
      runIds: [],
      step: 0,
      functionCallStepContentIds: {},
      durationRecorder: DurationRecorder.create(),
      activityTimeoutDeadlineMs: Date.now() + 60_000,
      enforcedInferenceHooks: [
        InferenceHookProviderFactory.enforced(
          InferenceHookProviderFactory.deny()
        ),
      ],
      monitoredInferenceHookIds: ["hook_a"],
    });

    expect(launchInferenceHookWorkflows).not.toHaveBeenCalled();
  });
});

describe("runModel server-side fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    shutdownMock.controller = new AbortController();
    vi.mocked(getLlmCredentials).mockResolvedValue({});
    vi.mocked(isFreeUsageBlocked).mockResolvedValue(false);
  });

  it("stores the served model on the agent message when another model answered", async () => {
    const { auth, agentMessage, contextProvider } =
      await InferenceHookRunModelFactory.create();
    await FeatureFlagFactory.basic(auth, "inference_hooks");
    // Deny after the model call to stop the run right after the output is handled.
    const provider = InferenceHookProviderFactory.custom(async (input) =>
      input.lifecycleEvent === "before_model_call"
        ? { action: "allow" }
        : { action: "deny", reason: "Stop here" }
    );
    vi.mocked(getOutputFromLLMStream).mockResolvedValue(
      new Ok({
        output: { actions: [], generation: "Hello", contents: [] },
        dustRunId: "dust_run_1",
        nativeChainOfThought: "",
        servedModel: "claude-opus-4-8",
      })
    );

    await runModel(auth, {
      contextProvider,
      runIds: [],
      step: 0,
      functionCallStepContentIds: {},
      durationRecorder: DurationRecorder.create(),
      activityTimeoutDeadlineMs: Date.now() + 60_000,
      enforcedInferenceHooks: [InferenceHookProviderFactory.enforced(provider)],
    });

    const row = await AgentMessageModel.findOne({
      where: {
        id: agentMessage.agentMessageId,
        workspaceId: auth.getNonNullableWorkspace().id,
      },
    });
    expect(row?.fallbackModelId).toBe("claude-opus-4-8");
  });
});
