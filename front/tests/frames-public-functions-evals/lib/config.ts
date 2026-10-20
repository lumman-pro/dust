import { Authenticator } from "@app/lib/auth";
import { runInCommittedTransaction } from "@app/tests/utils/eval_workspace";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { isModelId } from "@app/types/assistant/models/models";
import type { ModelIdType } from "@app/types/assistant/models/types";

export const RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL =
  process.env.RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL === "true";
export const JUDGE_RUNS = parseInt(process.env.JUDGE_RUNS ?? "3", 10);
export const PASS_THRESHOLD = parseInt(process.env.PASS_THRESHOLD ?? "2", 10);
export const FILTER_CATEGORY = process.env.FILTER_CATEGORY;
export const FILTER_SCENARIO = process.env.FILTER_SCENARIO;
export const VERBOSE = process.env.VERBOSE === "true";

function resolveModelId(): ModelIdType {
  const id = process.env.FRAMES_EVAL_MODEL_ID || "claude-sonnet-4-6";
  if (!isModelId(id)) {
    throw new Error(
      `Invalid FRAMES_EVAL_MODEL_ID: "${id}". Must be a known model ID.`
    );
  }
  return id;
}

export const MODEL_ID = resolveModelId();

export const TIMEOUT_MS = 300_000;

export async function getFramesEvalAuth(): Promise<Authenticator> {
  const workspace = await runInCommittedTransaction(() =>
    WorkspaceFactory.basic()
  );

  return Authenticator.internalAdminForWorkspace(workspace.sId);
}
