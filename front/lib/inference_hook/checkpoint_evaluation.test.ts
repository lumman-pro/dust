import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";
import { evaluateInferenceHookAtCheckpoint } from "@app/lib/inference_hook/checkpoint_evaluation";
import { loadInferenceHookInputFromCheckpoint } from "@app/lib/inference_hook/checkpoint_input";
import { getInferenceHook } from "@app/lib/inference_hook/registry";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { InferenceHookProviderFactory } from "@app/tests/utils/InferenceHookProviderFactory";
import { Err, Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/inference_hook/registry", () => ({
  getInferenceHook: vi.fn(),
}));

vi.mock("@app/lib/inference_hook/checkpoint_input", () => ({
  loadInferenceHookInputFromCheckpoint: vi.fn(),
}));

const checkpoint: InferenceHookCheckpointRef = {
  lifecycleEvent: "after_model_call",
  workspaceId: "w1",
  conversationId: "c1",
  agentMessageId: "m1",
  agentMessageVersion: 0,
  step: 0,
  dustRunId: "run_1",
};

describe("evaluateInferenceHookAtCheckpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("evaluates the input loaded for the checkpoint", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(auth);
    const provider = InferenceHookProviderFactory.deny("Flagged");
    vi.mocked(getInferenceHook).mockReturnValue({
      provider,
      timeoutMs: 1_000,
    });
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Ok(input)
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      checkpoint,
    });

    expect(loadInferenceHookInputFromCheckpoint).toHaveBeenCalledWith(
      auth,
      checkpoint
    );
    expect(provider.inputs).toEqual([input]);
    expect(result.isOk() && result.value).toEqual({
      action: "deny",
      reason: "Flagged",
    });
  });

  it("returns an error when the provider exceeds its timeout", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    vi.mocked(getInferenceHook).mockReturnValue({
      provider: InferenceHookProviderFactory.hanging(),
      timeoutMs: 10,
    });
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Ok(await InferenceHookInputFactory.afterModelCall(auth))
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      checkpoint,
    });

    expect(result.isErr()).toBe(true);
  });

  it("returns an error without evaluating when the input cannot be loaded", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    const provider = InferenceHookProviderFactory.allow();
    vi.mocked(getInferenceHook).mockReturnValue({
      provider,
      timeoutMs: 1_000,
    });
    vi.mocked(loadInferenceHookInputFromCheckpoint).mockResolvedValue(
      new Err(new Error("Checkpoint not found"))
    );

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "hook_a",
      checkpoint,
    });

    expect(result.isErr()).toBe(true);
    expect(provider.inputs).toEqual([]);
  });

  it("returns an error for an unknown hook", async () => {
    const { authenticator: auth } = await createResourceTest({ role: "admin" });
    vi.mocked(getInferenceHook).mockReturnValue(null);

    const result = await evaluateInferenceHookAtCheckpoint(auth, {
      hookId: "missing",
      checkpoint,
    });

    expect(result.isErr()).toBe(true);
    expect(loadInferenceHookInputFromCheckpoint).not.toHaveBeenCalled();
  });
});
