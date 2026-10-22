import type { Authenticator } from "@app/lib/auth";
import logger from "@app/logger/logger";
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
import { beforeAll, describe, expect, it } from "vitest";

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
              logger.info(
                { scenarioId: testCase.scenarioId, responseText },
                "Frames eval response"
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
              logger.info(
                { scenarioId: testCase.scenarioId, judgeResult },
                "Frames eval judge result"
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
