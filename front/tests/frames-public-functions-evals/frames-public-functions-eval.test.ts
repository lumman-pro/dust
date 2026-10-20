import type { Authenticator } from "@app/lib/auth";
import { validateGeneratedFrame } from "@app/tests/frames-public-functions-evals/lib/assertions";
import {
  FILTER_CATEGORY,
  FILTER_SCENARIO,
  getFramesEvalAuth,
  JUDGE_RUNS,
  PASS_THRESHOLD,
  RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL,
  TIMEOUT_MS,
  VERBOSE,
} from "@app/tests/frames-public-functions-evals/lib/config";
import { executeFramesAuthoring } from "@app/tests/frames-public-functions-evals/lib/executor";
import { evaluateWithJudge } from "@app/tests/frames-public-functions-evals/lib/judge";
import { filterTestCases } from "@app/tests/frames-public-functions-evals/lib/suite-loader";
import { allTestSuites } from "@app/tests/frames-public-functions-evals/test-suites";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("openai", async (importOriginal) => {
  const actual = await importOriginal();
  // @ts-expect-error actual is unknown
  const OriginalOpenAI = actual.OpenAI;
  class OpenAIWithBrowserSupport extends OriginalOpenAI {
    constructor(config: ConstructorParameters<typeof OriginalOpenAI>[0]) {
      super({ ...config, dangerouslyAllowBrowser: true });
    }
  }
  return { ...(actual as object), OpenAI: OpenAIWithBrowserSupport };
});

vi.mock("@anthropic-ai/sdk", async (importOriginal) => {
  const actual = await importOriginal();
  // @ts-expect-error actual is unknown
  const OriginalAnthropic = actual.default;
  class AnthropicWithBrowserSupport extends OriginalAnthropic {
    constructor(config: ConstructorParameters<typeof OriginalAnthropic>[0]) {
      super({ ...config, dangerouslyAllowBrowser: true });
    }
  }
  return { ...(actual as object), default: AnthropicWithBrowserSupport };
});

const testCases = RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL
  ? filterTestCases(allTestSuites, {
      category: FILTER_CATEGORY,
      scenarioId: FILTER_SCENARIO,
    })
  : [];

describe.skipIf(!RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL)(
  "Frames public functions evaluation",
  () => {
    let auth: Authenticator;

    beforeAll(async () => {
      auth = await getFramesEvalAuth();
    }, TIMEOUT_MS);

    for (const testCase of testCases) {
      describe(testCase.category, () => {
        it.concurrent(
          testCase.scenarioId,
          async () => {
            const { responseText, files } = await executeFramesAuthoring(
              auth,
              testCase
            );

            if (VERBOSE) {
              console.log(
                `[${testCase.scenarioId}] Response:\n${responseText}`
              );
            }

            const assertion = validateGeneratedFrame(testCase, files);
            expect(
              assertion.success,
              `${assertion.success ? "" : assertion.error}\n\nResponse:\n${responseText}`
            ).toBe(true);

            const judgeResult = await evaluateWithJudge(
              auth,
              testCase,
              files,
              JUDGE_RUNS
            );

            if (VERBOSE) {
              console.log(
                `[${testCase.scenarioId}] Judge:`,
                JSON.stringify(judgeResult, null, 2)
              );
            }

            expect(
              judgeResult.finalScore >= PASS_THRESHOLD,
              `Judge score ${judgeResult.finalScore} < threshold ${PASS_THRESHOLD}\nReasoning: ${judgeResult.reasoning}`
            ).toBe(true);
          },
          TIMEOUT_MS
        );
      });
    }
  }
);
