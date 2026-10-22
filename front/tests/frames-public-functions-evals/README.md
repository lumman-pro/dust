# Frames Public Functions Evaluation Tests

One-shot eval suite for the Frames v2 guidance on functions served to visitors of a public share
link. The model gets the real Frames v2 skill instructions (functions and public functions on)
and a user request, and writes every file of the Frame. Nothing runs in a sandbox: the eval
measures whether the guidance leads to the right declarations and code, not the publish pipeline.

Each test case checks two things:

- **Hard checks** on the written files: every function's `userIdentity` matches the scenario's
  expectations, every public function is `fast` in `manifest.json`, and no public function
  references a `DSEC_` secret or calls Dust tools.
- **LLM-as-judge**: a separate LLM scores the Frame (0-3) for leaks, caller handling and UI
  behavior against a common checklist and scenario-specific criteria.

## Quick start

```bash
cd front

NODE_ENV=test \
  TEST_FRONT_DATABASE_URI="$FRONT_DATABASE_URI"_test \
  RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL=true \
  npm run test -- tests/frames-public-functions-evals/frames-public-functions-eval.test.ts \
  --config tests/frames-public-functions-evals/vite.config.mjs
```

## Environment variables

| Variable                           | Default             | Description                                                   |
| ---------------------------------- | ------------------- | ------------------------------------------------------------- |
| `RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL` | `false`             | Set to `true` to enable the tests (skipped otherwise).        |
| `FRAMES_EVAL_MODEL_ID`             | `claude-sonnet-4-6` | Model that writes the Frame.                                  |
| `JUDGE_RUNS`                       | `3`                 | Number of judge evaluations per test (averaged).              |
| `PASS_THRESHOLD`                   | `2`                 | Minimum judge score (0-3) required to pass.                   |
| `FILTER_CATEGORY`                  | _(all)_             | Run only tests in the given suite.                            |
| `FILTER_SCENARIO`                  | _(all)_             | Run only the test with the given scenario ID.                 |
| `VERBOSE`                          | `false`             | Log the written Frame and the judge result for each scenario. |
| `DUST_MANAGED_ANTHROPIC_API_KEY`   | _(none)_            | Anthropic API key (required for Claude models).               |
| `DUST_MANAGED_OPENAI_API_KEY`      | _(none)_            | OpenAI API key (required for the GPT judge model).            |

## Adding tests

Add a scenario to `test-suites/public-functions.ts`, or a new suite exported from
`test-suites/index.ts`. A scenario lists `functionExpectations` (a function name pattern and
whether a matching function must be public) and `judgeCriteria` with its "Score 0-1 if…"
dealbreakers. The common checklist lives in `lib/judge.ts`.
