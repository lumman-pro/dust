import {
  makeInferenceHookDeniedError,
  runInferenceHooks,
} from "@app/lib/inference_hook";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookInputFactory } from "@app/tests/utils/InferenceHookInputFactory";
import { InferenceHookProviderFactory } from "@app/tests/utils/InferenceHookProviderFactory";
import { describe, expect, it, vi } from "vitest";

const notCancelled = new AbortController().signal;

describe("runInferenceHooks", () => {
  it("does no hook work when inference hooks are disabled", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const provider = InferenceHookProviderFactory.allow();

    const result = await runInferenceHooks({
      featureFlags: [],
      hooks: [InferenceHookProviderFactory.enforced(provider)],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "allow" });
    expect(provider.inputs).toHaveLength(0);
  });

  it("returns an explicit denial from any provider", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(authenticator);
    const allowProvider = InferenceHookProviderFactory.allow();
    const denyProvider = InferenceHookProviderFactory.deny("Policy denied");

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookProviderFactory.enforced(allowProvider),
        InferenceHookProviderFactory.enforced(denyProvider),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "deny", reason: "Policy denied" });
    expect(allowProvider.inputs).toEqual([input]);
    expect(denyProvider.inputs).toEqual([input]);
  });

  it("returns a denial without waiting for the other providers", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const pending = InferenceHookProviderFactory.slow({ delayMs: 60_000 });

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookProviderFactory.enforced(pending, { timeoutMs: 60_000 }),
        InferenceHookProviderFactory.enforced(
          InferenceHookProviderFactory.deny("Policy denied")
        ),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({ action: "deny", reason: "Policy denied" });
    expect(pending.signals[0].aborted).toBe(true);
  });

  it("starts all providers concurrently", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    let releaseProviders = () => {};
    const waitForRelease = new Promise<void>((resolve) => {
      releaseProviders = resolve;
    });
    const first = InferenceHookProviderFactory.custom(async () => {
      await waitForRelease;
      return { action: "allow" };
    });
    const second = InferenceHookProviderFactory.custom(async () => {
      await waitForRelease;
      return { action: "allow" };
    });

    const run = runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookProviderFactory.enforced(first),
        InferenceHookProviderFactory.enforced(second),
      ],
      input,
      signal: notCancelled,
    });

    await vi.waitFor(() => {
      expect(first.inputs).toEqual([input]);
      expect(second.inputs).toEqual([input]);
    });
    releaseProviders();

    await expect(run).resolves.toEqual({ action: "allow" });
  });

  it("applies each provider's onError policy to its failures", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.failing(),
            { onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.failing(),
            { onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("applies each provider's onError policy when it times out", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.slow({ delayMs: 100 }),
            { timeoutMs: 1, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.slow({ delayMs: 100 }),
            { timeoutMs: 1, onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("respects each provider's own timeoutMs", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.slow({
              delayMs: 50,
              verdict: { action: "deny", reason: "Long hook denied" },
            }),
            { timeoutMs: 500, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "deny", reason: "Long hook denied" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.slow({ delayMs: 50 }),
            { timeoutMs: 10, onError: "deny" }
          ),
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.allow(),
            { timeoutMs: 500, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("stops waiting at the timeout for a provider that ignores its signal", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.hanging(),
            { timeoutMs: 10, onError: "allow" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({ action: "allow" });

    await expect(
      runInferenceHooks({
        featureFlags: ["inference_hooks"],
        hooks: [
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.hanging(),
            { timeoutMs: 10, onError: "deny" }
          ),
        ],
        input,
        signal: notCancelled,
      })
    ).resolves.toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
  });

  it("does not start a queued provider whose timeout has passed", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const queued = InferenceHookProviderFactory.allow();

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        ...Array.from({ length: 8 }, () =>
          InferenceHookProviderFactory.enforced(
            InferenceHookProviderFactory.hanging(),
            { timeoutMs: 20, onError: "allow" }
          )
        ),
        InferenceHookProviderFactory.enforced(queued, {
          timeoutMs: 5,
          onError: "deny",
        }),
      ],
      input,
      signal: notCancelled,
    });

    expect(result).toEqual({
      action: "deny",
      reason: "Inference hook evaluation failed",
    });
    expect(queued.inputs).toHaveLength(0);
  });

  it("returns cancelled without evaluating when already cancelled", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input =
      await InferenceHookInputFactory.beforeModelCall(authenticator);
    const provider = InferenceHookProviderFactory.deny();
    const controller = new AbortController();
    controller.abort();

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [InferenceHookProviderFactory.enforced(provider)],
      input,
      signal: controller.signal,
    });

    expect(result).toEqual({ action: "cancelled" });
    expect(provider.inputs).toHaveLength(0);
  });

  it("aborts providers and returns cancelled when cancelled during evaluation", async () => {
    const { authenticator } = await createResourceTest({ role: "admin" });
    const input = await InferenceHookInputFactory.afterModelCall(authenticator);
    const provider = InferenceHookProviderFactory.slow({
      delayMs: 60_000,
      verdict: { action: "deny", reason: "Blocked by policy" },
    });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const result = await runInferenceHooks({
      featureFlags: ["inference_hooks"],
      hooks: [
        InferenceHookProviderFactory.enforced(provider, { timeoutMs: 60_000 }),
      ],
      input,
      signal: controller.signal,
    });

    expect(result).toEqual({ action: "cancelled" });
    expect(provider.signals[0].aborted).toBe(true);
  });
});

describe("makeInferenceHookDeniedError", () => {
  it("builds a hook-blocked error tagged with the lifecycle event", () => {
    expect(
      makeInferenceHookDeniedError("after_model_call", {
        action: "deny",
        reason: "Blocked by policy",
      })
    ).toEqual({
      code: "inference_hook_denied",
      message: "Blocked by policy",
      metadata: {
        category: "hook_blocked",
        lifecycleEvent: "after_model_call",
      },
    });
  });
});
