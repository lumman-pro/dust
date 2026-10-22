import { Authenticator } from "@app/lib/auth";
import { runInCommittedTransaction } from "@app/tests/utils/eval_workspace";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { isModelId } from "@app/types/assistant/models/models";
import type { ModelIdType } from "@app/types/assistant/models/types";
import { EnvironmentConfig } from "@app/types/shared/utils/config";

export const RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL =
  EnvironmentConfig.getOptionalEnvVariable(
    "RUN_FRAMES_PUBLIC_FUNCTIONS_EVAL"
  ) === "true";
export const JUDGE_RUNS = parseInt(
  EnvironmentConfig.getOptionalEnvVariable("JUDGE_RUNS") ?? "3",
  10
);
export const PASS_THRESHOLD = parseInt(
  EnvironmentConfig.getOptionalEnvVariable("PASS_THRESHOLD") ?? "2",
  10
);
export const FILTER_CATEGORY =
  EnvironmentConfig.getOptionalEnvVariable("FILTER_CATEGORY");
export const FILTER_SCENARIO =
  EnvironmentConfig.getOptionalEnvVariable("FILTER_SCENARIO");
export const VERBOSE =
  EnvironmentConfig.getOptionalEnvVariable("VERBOSE") === "true";

function resolveModelId(): ModelIdType {
  const id =
    EnvironmentConfig.getOptionalEnvVariable("FRAMES_EVAL_MODEL_ID") ??
    "claude-sonnet-4-6";
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
