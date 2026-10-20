import type { TestSuite } from "@app/tests/frames-public-functions-evals/lib/types";

export const publicFunctionsSuite: TestSuite = {
  name: "public-functions",
  description:
    "Authoring Frames whose functions are served to visitors of a public share link.",
  testCases: [
    {
      scenarioId: "public-todo",
      userMessage:
        "Build a todo list Frame I'll share with a public link. Anyone with the link can see " +
        "the todos, add one and tick one. Only I can clear the done ones.",
      functionExpectations: [
        { namePattern: /list|get/, policy: "public" },
        { namePattern: /add|create/, policy: "public" },
        { namePattern: /toggle|tick|check|complete|update/, policy: "public" },
        { namePattern: /clear|purge|delete|remove/, policy: "not_public" },
      ],
      judgeCriteria:
        "The clear action uses `frame_author_required`. Score 0-1 if a visitor can clear todos, " +
        "or if the UI shows the clear control to visitors without handling the 401.",
    },
    {
      scenarioId: "feedback-form",
      userMessage:
        "Make a feedback form Frame for a public link. Visitors leave a rating and a comment " +
        "anonymously. Only I can read the responses.",
      functionExpectations: [
        { namePattern: /submit|send|create|add|post/, policy: "public" },
        { namePattern: /list|get|read|responses/, policy: "not_public" },
      ],
      judgeCriteria:
        "The submit function returns only a confirmation, never other responses. Score 0-1 if " +
        "any visitor-reachable function returns stored responses, or if reading them is public.",
    },
    {
      scenarioId: "directory-private-fields",
      userMessage:
        "Build a team directory Frame for a public link. Visitors see each person's name and " +
        "role. People who can edit the Frame also see emails and phone numbers. Editors add " +
        "people.",
      functionExpectations: [
        { namePattern: /list|get|people|directory/, policy: "public" },
        { namePattern: /add|create|upsert|update|edit/, policy: "not_public" },
      ],
      judgeCriteria:
        "Emails and phones are returned only when `currentUser()?.canWriteFrameSource` is true. " +
        "Score 0-1 if private fields are gated on an input flag, always returned and only hidden " +
        "in the UI, or hard-coded in the UI source.",
    },
    {
      scenarioId: "status-page-from-jira",
      userMessage:
        "Build a public status page Frame showing our open Jira incidents. Anyone with the link " +
        "can view it. Refresh it from Jira.",
      functionExpectations: [
        { namePattern: /get|list|status|read|snapshot/, policy: "public" },
        { namePattern: /refresh|sync|update|fetch|pull/, policy: "not_public" },
      ],
      requiresToolCallingDurableFunction: true,
      judgeCriteria:
        "A durable non-public function calls Jira through `tools.call` and stores a snapshot. A " +
        "fast public function serves that snapshot. Score 0-1 if a public function calls Jira or " +
        "triggers the refresh.",
    },
  ],
};
