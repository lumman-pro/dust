import type { InferenceHookLifecycleEvent } from "@app/lib/inference_hook";
import { InferenceHookCheckpointModel } from "@app/lib/models/inference_hook";
import type { ModelId } from "@app/types/shared/model_id";
import type { LightWorkspaceType } from "@app/types/user";

export class InferenceHookCheckpointFactory {
  static async basic(
    workspace: LightWorkspaceType,
    {
      conversationModelId,
      agentMessageModelId,
      event = "before_model_call",
      step = 0,
      dustRunId = null,
    }: {
      conversationModelId: ModelId;
      agentMessageModelId: ModelId;
      event?: InferenceHookLifecycleEvent;
      step?: number;
      dustRunId?: string | null;
    }
  ): Promise<InferenceHookCheckpointModel> {
    return InferenceHookCheckpointModel.create({
      workspaceId: workspace.id,
      conversationId: conversationModelId,
      agentMessageId: agentMessageModelId,
      event,
      step,
      dustRunId,
      userId: null,
      decision: "pending",
      decidedAt: null,
    });
  }
}
