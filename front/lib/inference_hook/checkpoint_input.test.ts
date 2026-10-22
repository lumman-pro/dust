import type { ConversationWindowStateSnapshot } from "@app/lib/api/assistant/conversation_rendering/checkpointed_window_state";
import {
  makeConversationWindowCheckpoint,
  publishConversationWindowCheckpoint,
} from "@app/lib/api/assistant/conversation_rendering/conversation_window_checkpoint";
import type { Authenticator } from "@app/lib/auth";
import { isDustErrorWithCode } from "@app/lib/error";
import type { InferenceHookCheckpointRef } from "@app/lib/inference_hook";
import { loadInferenceHookInputFromCheckpoint } from "@app/lib/inference_hook/checkpoint_input";
import { AgentStepContentResource } from "@app/lib/resources/agent_step_content_resource";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import type { ModelId } from "@app/types/shared/model_id";
import { beforeEach, describe, expect, it } from "vitest";

const windowState: ConversationWindowStateSnapshot = {
  version: 1,
  interactions: [
    {
      messages: [
        {
          kind: "message",
          message: {
            role: "user",
            name: "Alice",
            content: [{ type: "text", text: "Hello" }],
            tokenCount: 5,
          },
        },
      ],
    },
  ],
  retainedTokens: 5,
  totalTokensBefore: 5,
  prunedTokens: 0,
};

async function publishWindow(
  {
    workspaceId,
    conversationId,
    agentMessageId,
    agentMessageVersion,
    step,
  }: InferenceHookCheckpointRef,
  { nowMs }: { nowMs?: number } = {}
) {
  const result = await publishConversationWindowCheckpoint(
    makeConversationWindowCheckpoint({
      nowMs,
      identity: {
        workspaceId,
        conversationId,
        agentMessageId,
        agentMessageVersion,
        step,
      },
      profileHash: "profile",
      promptTokens: 0,
      toolDefinitionTokens: 0,
      state: windowState,
    })
  );
  if (result.isErr()) {
    throw result.error;
  }
}

describe("loadInferenceHookInputFromCheckpoint", () => {
  let auth: Authenticator;
  let workspaceModelId: ModelId;
  let agentConfigurationId: string;
  let agentMessageModelId: ModelId;
  let beforeCheckpoint: InferenceHookCheckpointRef;

  beforeEach(async () => {
    fileStorageMock.reset();
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });
    auth = authenticator;
    workspaceModelId = workspace.id;

    const agentConfig = await AgentConfigurationFactory.createTestAgent(auth);
    agentConfigurationId = agentConfig.sId;
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: agentConfig.sId,
      messagesCreatedAt: [],
    });
    const { messageRow, agentMessage } =
      await ConversationFactory.createAgentMessage(auth, {
        workspace,
        conversation,
        agentConfig,
      });
    agentMessageModelId = agentMessage.agentMessageId;

    beforeCheckpoint = {
      lifecycleEvent: "before_model_call",
      workspaceId: workspace.sId,
      conversationId: conversation.sId,
      agentMessageId: messageRow.sId,
      agentMessageVersion: messageRow.version,
      step: 0,
    };
  });

  it("returns a checkpoint-unavailable error when the step has no conversation window checkpoint", async () => {
    fileStorageMock.setFetchFileContentNotFound(() => true);

    const result = await loadInferenceHookInputFromCheckpoint(
      auth,
      beforeCheckpoint
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(
      isDustErrorWithCode(result.error, "inference_hook_checkpoint_unavailable")
    ).toBe(true);
  });

  it("returns a checkpoint-unavailable error when the checkpoint has expired", async () => {
    await publishWindow(beforeCheckpoint, {
      nowMs: Date.now() - 24 * 60 * 60 * 1000,
    });

    const result = await loadInferenceHookInputFromCheckpoint(
      auth,
      beforeCheckpoint
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      return;
    }
    expect(
      isDustErrorWithCode(result.error, "inference_hook_checkpoint_unavailable")
    ).toBe(true);
  });

  it("rejects a checkpoint for another workspace", async () => {
    const result = await loadInferenceHookInputFromCheckpoint(auth, {
      ...beforeCheckpoint,
      workspaceId: "another_workspace",
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected a workspace mismatch error.");
    }
    expect(result.error.message).toContain(
      "Checkpoint workspace does not match authenticated workspace"
    );
  });

  it("rejects an agent message from another conversation", async () => {
    const otherConversation = await ConversationFactory.create(auth, {
      agentConfigurationId,
      messagesCreatedAt: [],
    });

    const result = await loadInferenceHookInputFromCheckpoint(auth, {
      ...beforeCheckpoint,
      conversationId: otherConversation.sId,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected a conversation mismatch error.");
    }
    expect(result.error.message).toContain("Agent message not found");
  });

  it("rejects a mismatched agent message version", async () => {
    const result = await loadInferenceHookInputFromCheckpoint(auth, {
      ...beforeCheckpoint,
      agentMessageVersion: beforeCheckpoint.agentMessageVersion + 1,
    });

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected an agent message version mismatch error.");
    }
    expect(result.error.message).toContain(
      "Agent message version does not match checkpoint"
    );
  });

  it("reads the conversation window from the step checkpoint", async () => {
    await publishWindow(beforeCheckpoint);

    const result = await loadInferenceHookInputFromCheckpoint(
      auth,
      beforeCheckpoint
    );
    if (result.isErr()) {
      throw result.error;
    }

    expect(result.value.conversationWindow.messages).toEqual([
      {
        role: "user",
        name: "Alice",
        content: [{ type: "text", text: "Hello" }],
      },
    ]);
    expect(result.value.agentConfiguration).not.toHaveProperty("instructions");
    expect(result.value.agentConfiguration).not.toHaveProperty(
      "instructionsHtml"
    );
  });

  it("builds the model output when a later run overwrites the same indexes", async () => {
    await publishWindow(beforeCheckpoint);
    const stepContent = {
      workspaceId: workspaceModelId,
      agentMessageId: agentMessageModelId,
      step: 0,
    };
    await AgentStepContentResource.createNewVersions([
      {
        ...stepContent,
        index: 0,
        type: "text_content",
        value: { type: "text_content", value: "Kept" },
        dustRunId: "run_1",
      },
      {
        ...stepContent,
        index: 1,
        type: "function_call",
        value: {
          type: "function_call",
          value: { id: "call_1", name: "search", arguments: "{}" },
        },
        dustRunId: "run_1",
      },
    ]);
    await AgentStepContentResource.createNewVersions([
      {
        ...stepContent,
        index: 0,
        type: "text_content",
        value: { type: "text_content", value: "Other run" },
        dustRunId: "run_2",
      },
      {
        ...stepContent,
        index: 1,
        type: "function_call",
        value: {
          type: "function_call",
          value: { id: "call_2", name: "other_search", arguments: "{}" },
        },
        dustRunId: "run_2",
      },
    ]);

    const result = await loadInferenceHookInputFromCheckpoint(auth, {
      ...beforeCheckpoint,
      lifecycleEvent: "after_model_call",
      dustRunId: "run_1",
    });
    if (result.isErr()) {
      throw result.error;
    }
    if (result.value.lifecycleEvent !== "after_model_call") {
      throw new Error("Expected an after_model_call input.");
    }

    expect(result.value.modelOutput.generation).toBe("Kept");
    expect(result.value.modelOutput.actions).toEqual([
      { functionCallId: "call_1", name: "search" },
    ]);
    expect(result.value.modelOutput.contents).toHaveLength(2);
  });
});
