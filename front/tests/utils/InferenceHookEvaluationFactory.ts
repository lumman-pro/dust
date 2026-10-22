import type { InferenceHookCheckpointModel } from "@app/lib/models/inference_hook";
import {
  InferenceHookEvaluationModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import type { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import type { LightWorkspaceType } from "@app/types/user";
import assert from "assert";

export class InferenceHookEvaluationFactory {
  static async basic(
    workspace: LightWorkspaceType,
    {
      checkpoint,
      hook,
      index = 0,
    }: {
      checkpoint: InferenceHookCheckpointModel;
      hook: InferenceHookResource;
      index?: number;
    }
  ): Promise<InferenceHookEvaluationModel> {
    const hookVersion = await InferenceHookVersionModel.findOne({
      where: {
        workspaceId: workspace.id,
        hookId: hook.id,
        version: hook.currentVersion,
      },
    });
    assert(hookVersion, "The hook must have a current version.");

    return InferenceHookEvaluationModel.create({
      workspaceId: workspace.id,
      checkpointId: checkpoint.id,
      hookVersionId: hookVersion.id,
      index,
      status: "pending",
      requestedAt: new Date(),
      startedAt: null,
      completedAt: null,
      verdict: null,
      reason: null,
      outcome: null,
      errorCode: null,
      errorMessage: null,
      providerReference: null,
    });
  }
}
