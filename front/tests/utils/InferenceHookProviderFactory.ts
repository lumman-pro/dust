import type {
  EnforcedInferenceHook,
  InferenceHookProvider,
  InferenceHookInput,
  InferenceHookOnError,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";

export interface FakeInferenceHookProvider extends InferenceHookProvider {
  readonly inputs: InferenceHookInput[];
  readonly signals: AbortSignal[];
}

function createFakeInferenceHookProvider(
  evaluate: (
    input: InferenceHookInput,
    options: { signal: AbortSignal }
  ) => Promise<InferenceHookVerdict>
): FakeInferenceHookProvider {
  const inputs: InferenceHookInput[] = [];
  const signals: AbortSignal[] = [];

  return {
    inputs,
    signals,
    async evaluate(input, options) {
      inputs.push(input);
      signals.push(options.signal);
      return evaluate(input, options);
    },
  };
}

export class InferenceHookProviderFactory {
  static custom(
    evaluate: (
      input: InferenceHookInput,
      options: { signal: AbortSignal }
    ) => Promise<InferenceHookVerdict>
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(evaluate);
  }

  static allow(): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => ({ action: "allow" }));
  }

  static deny(
    reason = "Denied by the fake inference hook provider"
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => ({
      action: "deny",
      reason,
    }));
  }

  static slow({
    delayMs,
    verdict = { action: "allow" },
  }: {
    delayMs: number;
    verdict?: InferenceHookVerdict;
  }): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(
      (_input, { signal }) =>
        new Promise((resolve, reject) => {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Fake inference hook provider aborted"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve(verdict);
          }, delayMs);

          signal.addEventListener("abort", onAbort, { once: true });
        })
    );
  }

  // Ignores its abort signal and never settles, like a faulty provider adapter.
  static hanging(): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(() => new Promise(() => {}));
  }

  static failing(
    error = new Error("Fake inference hook provider failed")
  ): FakeInferenceHookProvider {
    return createFakeInferenceHookProvider(async () => {
      throw error;
    });
  }

  static enforced(
    provider: InferenceHookProvider,
    {
      timeoutMs = 1_000,
      onError = "deny",
    }: {
      timeoutMs?: number;
      onError?: InferenceHookOnError;
    } = {}
  ): EnforcedInferenceHook {
    return { provider, timeoutMs, onError };
  }
}
