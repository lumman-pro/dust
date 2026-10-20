import type {
  CategorizedTestCase,
  TestSuite,
} from "@app/tests/frames-public-functions-evals/lib/types";

type FilterTestCasesInput = {
  category?: string;
  scenarioId?: string;
};

export function filterTestCases(
  suites: TestSuite[],
  { category, scenarioId }: FilterTestCasesInput
): CategorizedTestCase[] {
  return suites
    .flatMap((suite) =>
      suite.testCases.map((testCase) => ({ ...testCase, category: suite.name }))
    )
    .filter((testCase) => !category || testCase.category === category)
    .filter((testCase) => !scenarioId || testCase.scenarioId === scenarioId);
}
