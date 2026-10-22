import type { Authenticator } from "@app/lib/auth";
import {
  InferenceHookCheckpointModel,
  InferenceHookEvaluationModel,
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { BaseResource } from "@app/lib/resources/base_resource";
import type { ReadonlyAttributesType } from "@app/lib/resources/storage/types";
import type { ModelStaticWorkspaceAware } from "@app/lib/resources/storage/wrappers/workspace_models";
import { withTransaction } from "@app/lib/utils/sql_utils";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Ok } from "@app/types/shared/result";
import assert from "assert";
import type { Attributes, Transaction } from "sequelize";
import { Op } from "sequelize";

export interface InferenceHookResource extends ReadonlyAttributesType<InferenceHookModel> {}

/**
 * @cc [owner:sfriquet,label:architecture;backend] inference-hook-models-behind-resource
 * Runtime code MUST read and write the inference hook models of `lib/models/inference_hook.ts`
 * (hooks, their versions, checkpoints and evaluations) only through `InferenceHookResource`.
 */
export class InferenceHookResource extends BaseResource<InferenceHookModel> {
  static model: ModelStaticWorkspaceAware<InferenceHookModel> =
    InferenceHookModel;

  constructor(
    model: ModelStaticWorkspaceAware<InferenceHookModel>,
    blob: Attributes<InferenceHookModel>
  ) {
    super(model, blob);
  }

  static async deleteAllForWorkspace(auth: Authenticator): Promise<void> {
    const workspaceId = auth.getNonNullableWorkspace().id;

    await withTransaction(async (transaction) => {
      await InferenceHookVersionModel.destroy({
        where: { workspaceId },
        transaction,
      });
      await this.model.destroy({
        where: { workspaceId },
        transaction,
      });
    });
  }

  static async deleteCheckpointsByAgentMessageModelIds(
    auth: Authenticator,
    { agentMessageModelIds }: { agentMessageModelIds: ModelId[] }
  ): Promise<number> {
    const workspaceId = auth.getNonNullableWorkspace().id;
    const checkpoints = await InferenceHookCheckpointModel.findAll({
      attributes: ["id"],
      where: {
        workspaceId,
        agentMessageId: { [Op.in]: agentMessageModelIds },
      },
    });
    const checkpointModelIds = checkpoints.map((c) => c.id);

    await InferenceHookEvaluationModel.destroy({
      where: { workspaceId, checkpointId: { [Op.in]: checkpointModelIds } },
    });

    return InferenceHookCheckpointModel.destroy({
      where: { workspaceId, id: { [Op.in]: checkpointModelIds } },
    });
  }

  async delete(
    auth: Authenticator,
    { transaction }: { transaction?: Transaction }
  ): Promise<Result<undefined, Error>> {
    const workspaceId = auth.getNonNullableWorkspace().id;
    assert(
      this.workspaceId === workspaceId,
      "Can only delete inference hooks of the current workspace"
    );

    await withTransaction(async (t) => {
      await InferenceHookVersionModel.destroy({
        where: { workspaceId, hookId: this.id },
        transaction: t,
      });
      await this.model.destroy({
        where: { workspaceId, id: this.id },
        transaction: t,
      });
    }, transaction);

    return new Ok(undefined);
  }
}
