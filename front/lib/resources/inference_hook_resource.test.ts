import { Authenticator } from "@app/lib/auth";
import {
  InferenceHookCheckpointModel,
  InferenceHookEvaluationModel,
  InferenceHookModel,
  InferenceHookVersionModel,
} from "@app/lib/models/inference_hook";
import { InferenceHookResource } from "@app/lib/resources/inference_hook_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { InferenceHookCheckpointFactory } from "@app/tests/utils/InferenceHookCheckpointFactory";
import { InferenceHookEvaluationFactory } from "@app/tests/utils/InferenceHookEvaluationFactory";
import { InferenceHookFactory } from "@app/tests/utils/InferenceHookFactory";
import { UserFactory } from "@app/tests/utils/UserFactory";
import { WorkspaceFactory } from "@app/tests/utils/WorkspaceFactory";
import { isAgentMessageType } from "@app/types/assistant/conversation";
import type { ModelId } from "@app/types/shared/model_id";
import type { LightWorkspaceType, WorkspaceType } from "@app/types/user";
import { beforeEach, describe, expect, it } from "vitest";

async function countRows(workspace: WorkspaceType) {
  return {
    hooks: await InferenceHookModel.count({
      where: { workspaceId: workspace.id },
    }),
    versions: await InferenceHookVersionModel.count({
      where: { workspaceId: workspace.id },
    }),
  };
}

describe("InferenceHookResource", () => {
  describe("deleteAllForWorkspace", () => {
    it("deletes the hooks and versions of the workspace only", async () => {
      const user = await UserFactory.basic();
      const workspace = await WorkspaceFactory.basic();
      const otherWorkspace = await WorkspaceFactory.basic();
      await InferenceHookFactory.basic(workspace, user);
      await InferenceHookFactory.basic(workspace, user);
      await InferenceHookFactory.basic(otherWorkspace, user);

      await InferenceHookResource.deleteAllForWorkspace(
        await Authenticator.internalAdminForWorkspace(workspace.sId)
      );

      expect(await countRows(workspace)).toEqual({ hooks: 0, versions: 0 });
      expect(await countRows(otherWorkspace)).toEqual({
        hooks: 1,
        versions: 1,
      });
    });
  });

  describe("delete", () => {
    it("deletes the hook and its versions", async () => {
      const user = await UserFactory.basic();
      const workspace = await WorkspaceFactory.basic();
      const hook = await InferenceHookFactory.basic(workspace, user);
      const otherHook = await InferenceHookFactory.basic(workspace, user);

      const result = await hook.delete(
        await Authenticator.internalAdminForWorkspace(workspace.sId),
        {}
      );

      expect(result.isOk()).toBe(true);
      const remainingHooks = await InferenceHookModel.findAll({
        where: { workspaceId: workspace.id },
      });
      const remainingVersions = await InferenceHookVersionModel.findAll({
        where: { workspaceId: workspace.id },
      });
      expect(remainingHooks.map((h) => h.id)).toEqual([otherHook.id]);
      expect(remainingVersions.map((v) => v.hookId)).toEqual([otherHook.id]);
    });
  });

  describe("checkpoints", () => {
    let auth: Authenticator;
    let workspace: LightWorkspaceType;
    let conversationModelId: ModelId;
    let agentMessageModelIds: ModelId[];
    let hook: InferenceHookResource;

    beforeEach(async () => {
      const setup = await createResourceTest({});
      auth = setup.authenticator;
      workspace = setup.workspace;
      hook = await InferenceHookFactory.basic(workspace, setup.user);

      const agent = await AgentConfigurationFactory.createTestAgent(auth);
      const conversation = await ConversationFactory.create(auth, {
        agentConfigurationId: agent.sId,
        messagesCreatedAt: [new Date(), new Date()],
      });
      conversationModelId = conversation.id;
      agentMessageModelIds = conversation.content
        .flat()
        .filter(isAgentMessageType)
        .map((message) => message.agentMessageId);
    });

    it("keeps one before_model_call checkpoint per agent message step", async () => {
      const [agentMessageModelId] = agentMessageModelIds;
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId,
      });

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
        })
      ).rejects.toThrow();
    });

    it("keeps one after_model_call checkpoint per model run", async () => {
      const [agentMessageModelId] = agentMessageModelIds;
      const afterModelCall = {
        conversationModelId,
        agentMessageModelId,
        event: "after_model_call" as const,
      };
      await InferenceHookCheckpointFactory.basic(workspace, {
        ...afterModelCall,
        dustRunId: "run-1",
      });
      await InferenceHookCheckpointFactory.basic(workspace, {
        ...afterModelCall,
        dustRunId: "run-2",
      });

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          ...afterModelCall,
          dustRunId: "run-1",
        })
      ).rejects.toThrow();
    });

    it("requires a dustRunId for after_model_call checkpoints only", async () => {
      const [agentMessageModelId] = agentMessageModelIds;

      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
          event: "before_model_call",
          dustRunId: "run-1",
        })
      ).rejects.toThrow("dustRunId must be set for after_model_call");
      await expect(
        InferenceHookCheckpointFactory.basic(workspace, {
          conversationModelId,
          agentMessageModelId,
          event: "after_model_call",
          dustRunId: null,
        })
      ).rejects.toThrow("dustRunId must be set for after_model_call");
    });

    it("deletes the checkpoints of the given agent messages only", async () => {
      const [deletedAgentMessageModelId, keptAgentMessageModelId] =
        agentMessageModelIds;
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: deletedAgentMessageModelId,
      });
      await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: keptAgentMessageModelId,
      });

      await InferenceHookResource.deleteCheckpointsByAgentMessageModelIds(
        auth,
        {
          agentMessageModelIds: [deletedAgentMessageModelId],
        }
      );

      const remaining = await InferenceHookCheckpointModel.findAll({
        where: {
          workspaceId: workspace.id,
          conversationId: conversationModelId,
        },
      });
      expect(remaining.map((c) => c.agentMessageId)).toEqual([
        keptAgentMessageModelId,
      ]);
    });

    it("keeps one evaluation per try of a hook version at a checkpoint", async () => {
      const checkpoint = await InferenceHookCheckpointFactory.basic(workspace, {
        conversationModelId,
        agentMessageModelId: agentMessageModelIds[0],
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint,
        hook,
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint,
        hook,
        index: 1,
      });

      await expect(
        InferenceHookEvaluationFactory.basic(workspace, { checkpoint, hook })
      ).rejects.toThrow();
    });

    it("deletes the evaluations of the deleted checkpoints", async () => {
      const [deletedAgentMessageModelId, keptAgentMessageModelId] =
        agentMessageModelIds;
      const deletedCheckpoint = await InferenceHookCheckpointFactory.basic(
        workspace,
        { conversationModelId, agentMessageModelId: deletedAgentMessageModelId }
      );
      const keptCheckpoint = await InferenceHookCheckpointFactory.basic(
        workspace,
        { conversationModelId, agentMessageModelId: keptAgentMessageModelId }
      );
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint: deletedCheckpoint,
        hook,
      });
      await InferenceHookEvaluationFactory.basic(workspace, {
        checkpoint: keptCheckpoint,
        hook,
      });

      await InferenceHookResource.deleteCheckpointsByAgentMessageModelIds(
        auth,
        { agentMessageModelIds: [deletedAgentMessageModelId] }
      );

      const remaining = await InferenceHookEvaluationModel.findAll({
        where: { workspaceId: workspace.id },
      });
      expect(remaining.map((e) => e.checkpointId)).toEqual([keptCheckpoint.id]);
    });
  });
});
