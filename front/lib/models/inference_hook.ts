import type {
  InferenceHookCheckpointDecision,
  InferenceHookEnforcement,
  InferenceHookEvaluationErrorCode,
  InferenceHookEvaluationOutcome,
  InferenceHookEvaluationStatus,
  InferenceHookLifecycleEvent,
  InferenceHookOnError,
  InferenceHookProviderConfig,
  InferenceHookProviderIdType,
  InferenceHookVerdict,
} from "@app/lib/inference_hook";
import {
  AgentMessageModel,
  ConversationModel,
} from "@app/lib/models/agent/conversation";
import { frontSequelize } from "@app/lib/resources/storage";
import {
  DANGEROUSLY_UNBOUNDED_TEXT,
  DataTypes,
} from "@app/lib/resources/storage/data_types";
import { UserModel } from "@app/lib/resources/storage/models/user";
import { WorkspaceAwareModel } from "@app/lib/resources/storage/wrappers/workspace_models";
import type { ModelId } from "@app/types/shared/model_id";
import type { CreationOptional, ForeignKey } from "sequelize";

/**
 * @cc [owner:sfriquet,label:backend] inference-hook-current-version-pointer
 * `currentVersion` MUST equal the highest `version` among the hook's rows in
 * `inference_hook_versions`, and a hook MUST NOT exist without such a row. A transaction that
 * inserts a version row MUST leave `currentVersion` satisfying this before it commits. The current
 * version is the row matching `(hookId, version) = (inference_hooks.id,
 * inference_hooks.currentVersion)`, served by that unique index.
 */
export class InferenceHookModel extends WorkspaceAwareModel<InferenceHookModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare provider: InferenceHookProviderIdType;
  declare name: string;
  declare currentVersion: number;
  declare archivedAt: Date | null;

  declare createdByUserId: ForeignKey<UserModel["id"]>;
}

InferenceHookModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    currentVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    archivedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    modelName: "inference_hook",
    sequelize: frontSequelize,
    indexes: [
      { fields: ["workspaceId"], concurrently: true },
      { fields: ["createdByUserId"], concurrently: true },
    ],
  }
);

UserModel.hasMany(InferenceHookModel, {
  foreignKey: { name: "createdByUserId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookModel.belongsTo(UserModel, {
  foreignKey: { name: "createdByUserId", allowNull: false },
});

/**
 * @cc [owner:sfriquet,label:backend] inference-hook-versions-immutable
 * A row of `inference_hook_versions` MUST NOT be updated after insert. Changing any of its fields
 * MUST insert a new version row, so the settings a hook ran with at any time can be rebuilt.
 */
export class InferenceHookVersionModel extends WorkspaceAwareModel<InferenceHookVersionModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare version: number;
  declare events: InferenceHookLifecycleEvent[];
  declare enforcement: InferenceHookEnforcement | null;
  declare onError: InferenceHookOnError;
  declare timeoutMs: number;
  declare excludedGroupIds: CreationOptional<ModelId[]>;
  declare credentialId: string | null;
  declare providerConfig: InferenceHookProviderConfig;

  declare hookId: ForeignKey<InferenceHookModel["id"]>;
  declare authorId: ForeignKey<UserModel["id"]>;
}

InferenceHookVersionModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    version: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    events: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
    },
    enforcement: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    onError: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    timeoutMs: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    excludedGroupIds: {
      type: DataTypes.ARRAY(DataTypes.BIGINT),
      allowNull: false,
      defaultValue: [],
    },
    credentialId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    providerConfig: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
  },
  {
    modelName: "inference_hook_version",
    sequelize: frontSequelize,
    indexes: [
      { fields: ["workspaceId"], concurrently: true },
      { fields: ["hookId", "version"], unique: true, concurrently: true },
      { fields: ["authorId"], concurrently: true },
    ],
  }
);

InferenceHookModel.hasMany(InferenceHookVersionModel, {
  foreignKey: { name: "hookId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookVersionModel.belongsTo(InferenceHookModel, {
  foreignKey: { name: "hookId", allowNull: false },
  onDelete: "RESTRICT",
});

UserModel.hasMany(InferenceHookVersionModel, {
  foreignKey: { name: "authorId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookVersionModel.belongsTo(UserModel, {
  foreignKey: { name: "authorId", allowNull: false },
});

/**
 * @cc [owner:sfriquet,label:backend] inference-hook-checkpoint-unique-per-run
 * At most one row MUST exist per `(agentMessageId, step, event, dustRunId)`, with a NULL
 * `dustRunId` counted as a value: one `before_model_call` checkpoint per agent message step, and
 * one `after_model_call` checkpoint per model run of that step.
 */
/**
 * @cc [owner:sfriquet,label:backend] inference-hook-checkpoint-run-id-matches-event
 * `dustRunId` MUST be NULL when `event` is `before_model_call` and MUST NOT be NULL when `event` is
 * `after_model_call`; creating or saving a row that breaks this MUST fail.
 */
export class InferenceHookCheckpointModel extends WorkspaceAwareModel<InferenceHookCheckpointModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare event: InferenceHookLifecycleEvent;
  declare step: number;
  declare dustRunId: string | null;
  declare decision: InferenceHookCheckpointDecision;
  declare decidedAt: Date | null;

  declare conversationId: ForeignKey<ConversationModel["id"]>;
  declare agentMessageId: ForeignKey<AgentMessageModel["id"]>;
  declare userId: ForeignKey<UserModel["id"]> | null;
}

InferenceHookCheckpointModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    event: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    step: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    dustRunId: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    decision: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    decidedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    modelName: "inference_hook_checkpoint",
    sequelize: frontSequelize,
    indexes: [
      { fields: ["workspaceId"], concurrently: true },
      {
        name: "inference_hook_checkpoints_agent_message_step_event_run",
        fields: ["agentMessageId", "step", "event", "dustRunId"],
        unique: true,
        concurrently: true,
      },
      {
        name: "inference_hook_checkpoints_agent_message_step_event_no_run",
        fields: ["agentMessageId", "step", "event"],
        unique: true,
        where: { dustRunId: null },
        concurrently: true,
      },
      { fields: ["conversationId"], concurrently: true },
      { fields: ["userId"], concurrently: true },
    ],
    validate: {
      dustRunIdMatchesEvent(this: InferenceHookCheckpointModel): void {
        const hasDustRunId = this.dustRunId !== null;
        if (hasDustRunId !== (this.event === "after_model_call")) {
          throw new Error(
            "dustRunId must be set for after_model_call checkpoints only"
          );
        }
      },
    },
  }
);

ConversationModel.hasMany(InferenceHookCheckpointModel, {
  foreignKey: { name: "conversationId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookCheckpointModel.belongsTo(ConversationModel, {
  foreignKey: { name: "conversationId", allowNull: false },
});

AgentMessageModel.hasMany(InferenceHookCheckpointModel, {
  foreignKey: { name: "agentMessageId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookCheckpointModel.belongsTo(AgentMessageModel, {
  foreignKey: { name: "agentMessageId", allowNull: false },
});

UserModel.hasMany(InferenceHookCheckpointModel, {
  foreignKey: { name: "userId", allowNull: true },
  onDelete: "RESTRICT",
});
InferenceHookCheckpointModel.belongsTo(UserModel, {
  foreignKey: { name: "userId", allowNull: true },
});

export class InferenceHookEvaluationModel extends WorkspaceAwareModel<InferenceHookEvaluationModel> {
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare index: number;
  declare status: InferenceHookEvaluationStatus;
  declare requestedAt: Date;
  declare startedAt: Date | null;
  declare completedAt: Date | null;
  declare verdict: InferenceHookVerdict["action"] | null;
  declare reason: string | null;
  declare outcome: InferenceHookEvaluationOutcome | null;
  declare errorCode: InferenceHookEvaluationErrorCode | null;
  declare errorMessage: string | null;
  declare tags: CreationOptional<string[]>;
  declare providerReference: string | null;

  declare checkpointId: ForeignKey<InferenceHookCheckpointModel["id"]>;
  declare hookVersionId: ForeignKey<InferenceHookVersionModel["id"]>;
}

InferenceHookEvaluationModel.init(
  {
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    updatedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    index: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    requestedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    completedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    verdict: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    reason: {
      type: DANGEROUSLY_UNBOUNDED_TEXT,
      allowNull: true,
    },
    outcome: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    errorCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    errorMessage: {
      type: DANGEROUSLY_UNBOUNDED_TEXT,
      allowNull: true,
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [],
    },
    providerReference: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    modelName: "inference_hook_evaluation",
    sequelize: frontSequelize,
    indexes: [
      {
        fields: ["checkpointId", "hookVersionId", "index"],
        unique: true,
        concurrently: true,
      },
      { fields: ["workspaceId", "createdAt"], concurrently: true },
      { fields: ["hookVersionId", "createdAt"], concurrently: true },
    ],
  }
);

InferenceHookCheckpointModel.hasMany(InferenceHookEvaluationModel, {
  foreignKey: { name: "checkpointId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookEvaluationModel.belongsTo(InferenceHookCheckpointModel, {
  foreignKey: { name: "checkpointId", allowNull: false },
});

InferenceHookVersionModel.hasMany(InferenceHookEvaluationModel, {
  foreignKey: { name: "hookVersionId", allowNull: false },
  onDelete: "RESTRICT",
});
InferenceHookEvaluationModel.belongsTo(InferenceHookVersionModel, {
  foreignKey: { name: "hookVersionId", allowNull: false },
});
