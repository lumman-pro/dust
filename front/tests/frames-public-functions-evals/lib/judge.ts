import type { Authenticator } from "@app/lib/auth";
import type {
  JudgeResult,
  TestCase,
} from "@app/tests/frames-public-functions-evals/lib/types";
import { getJudgeLLM } from "@app/tests/utils/eval_llm";

const JUDGE_PROMPT = `You are evaluating Frame source written by an agent following the Frames v2 skill.

The Frame is shared by a public link. Visitors outside the workspace verify an email, then may call \
only the functions whose schema declares \`userIdentity: "public"\`. Workspace members may call every \
function their membership allows.

## Scoring Rubric

- 0: A visitor can reach private data or a privileged action, or the Frame does not do what was asked
- 1: Access is safe but a key requirement or a scenario rule below is missed
- 2: Correct and safe, with minor issues
- 3: Correct, safe and clean

You MUST provide your response in this exact format:

REASONING: <your detailed analysis>
SCORE: <number>

Where <number> is between 0 and 3. The score MUST appear at the end of your response.

---

## User Request

{{USER_MESSAGE}}

## Files Written

{{FILES}}

## Scenario-Specific Criteria

{{JUDGE_CRITERIA}}

---

## General Checklist

1. **Policy per function**: each function has one clear policy. Visitor-facing reads and writes are \
\`public\`. Owner-only or member-only actions use another policy.
2. **No leaks**: no public function returns private rows or fields, and no private data is \
hard-coded in the UI source, which every visitor downloads.
3. **Caller handling**: public functions treat \`currentUser()\` as possibly null. Extra data for some \
callers is decided from \`currentUser()\` (non-null for members, \`canWriteFrameSource\` for Frame \
editors), never from a value the caller sends.
4. **UI**: member-only controls are hidden from visitors, and \`user_authentication_required\` shows a \
message. Failed calls are not retried automatically.

Provide your evaluation using the REASONING: and SCORE: format described above.`;

function formatFiles(files: Map<string, string>): string {
  if (files.size === 0) {
    return "(none)";
  }

  return [...files.entries()]
    .map(([path, content]) => `### ${path}\n\n${content}`)
    .join("\n\n");
}

export async function evaluateWithJudge(
  auth: Authenticator,
  testCase: TestCase,
  files: Map<string, string>,
  numRuns: number
): Promise<JudgeResult> {
  const prompt = JUDGE_PROMPT.replace(
    "{{USER_MESSAGE}}",
    () => testCase.userMessage
  )
    .replace("{{FILES}}", () => formatFiles(files))
    .replace("{{JUDGE_CRITERIA}}", () => testCase.judgeCriteria);

  const scores: number[] = [];
  let lastReasoning = "";

  for (let i = 0; i < numRuns; i++) {
    const llm = await getJudgeLLM(auth);
    const events = llm.stream({
      conversation: {
        messages: [
          {
            role: "user",
            name: "User",
            content: [{ type: "text", text: prompt }],
          },
        ],
      },
      prompt:
        "You are a careful security-minded reviewer. Analyze the Frame source and provide a fair assessment.",
      specifications: [],
    });

    let response = "";
    for await (const event of events) {
      if (event.type === "text_delta") {
        response += event.content.delta;
      }
      if (event.type === "error") {
        throw new Error(`Judge evaluation error: ${event.content.message}`);
      }
    }

    const scoreMatch = response.match(/SCORE:\s*(\d)/i);
    if (scoreMatch) {
      const score = parseInt(scoreMatch[1], 10);
      if (score >= 0 && score <= 3) {
        scores.push(score);
      }
    }

    const reasoningMatch = response.match(
      /REASONING:\s*([\s\S]+?)(?=SCORE:|$)/i
    );
    if (reasoningMatch) {
      lastReasoning = reasoningMatch[1].trim();
    }
  }

  const finalScore =
    scores.length > 0
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

  return { finalScore, scores, reasoning: lastReasoning };
}
