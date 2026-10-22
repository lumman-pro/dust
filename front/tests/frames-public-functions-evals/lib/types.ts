export type FunctionPolicyExpectation = {
  namePattern: RegExp;
  policy: "public" | "not_public";
};

export interface TestCase {
  scenarioId: string;
  userMessage: string;
  functionExpectations: FunctionPolicyExpectation[];
  requiresToolCallingDurableFunction?: boolean;
  judgeCriteria: string;
}

export interface TestSuite {
  name: string;
  description: string;
  testCases: TestCase[];
}

export interface CategorizedTestCase extends TestCase {
  category: string;
}

export interface GeneratedFunction {
  name: string;
  executionMode: "fast" | "durable";
  userIdentity: string | null;
  source: string;
}

export interface ExecutionResult {
  responseText: string;
  files: Map<string, string>;
}

export interface JudgeResult {
  finalScore: number;
  scores: number[];
  reasoning: string;
}

export type AssertionResult =
  | { success: true }
  | { success: false; error: string };
