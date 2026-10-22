import { getPinnedAgentToolingForAgentMessage } from "@app/lib/api/assistant/configuration/run_configuration";
import { loadConversationWindowCheckpoint } from "@app/lib/api/assistant/conversation_rendering/conversation_window_checkpoint";
import { renderConversationWindowCheckpoint } from "@app/lib/api/assistant/conversation_rendering/conversation_window_core";
import type { Authenticator } from "@app/lib/auth";
import { DustError } from "@app/lib/error";
import type {
  InferenceHookCheckpointRef,
  InferenceHookInput,
} from "@app/lib/inference_hook";
import { AgentStepContentResource } from "@app/lib/resources/agent_step_content_resource";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import {
  isAgentFunctionCallContent,
  isAgentTextContent,
} from "@app/types/assistant/agent_message_content";
import type {
  ModelConversationTypeMultiActions,
  NormalizedModelOutput,
} from "@app/types/assistant/generation";
import type { ModelId } from "@app/types/shared/model_id";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";

/**
 * @cc [owner:frankaloia,label:product] hook-input-reads-step-checkpoint
 * `conversationWindow` MUST come from the conversation window checkpoint persisted for
 * `checkpoint`'s step. When that checkpoint is missing or expired, the loader MUST return an
 * `inference_hook_checkpoint_unavailable` error instead of rendering the current conversation.
 */
/**
 * @cc [owner:frankaloia,label:security;product] hook-input-bound-to-checkpoint-identity
 * The loader MUST return an error when `checkpoint.workspaceId` is not the authenticated workspace,
 * when the agent message is not in `checkpoint.conversationId`, or when its version differs from
 * `checkpoint.agentMessageVersion`.
 */
export async function loadInferenceHookInputFromCheckpoint(
  auth: Authenticator,
  checkpoint: InferenceHookCheckpointRef
): Promise<Result<InferenceHookInput, Error>> {
  const contextRes = await loadHookContext(auth, checkpoint);
  if (contextRes.isErr()) {
    return contextRes;
  }

  const windowRes = await loadConversationWindow(checkpoint);
  if (windowRes.isErr()) {
    return windowRes;
  }

  const { agentConfiguration, agentMessageModelId } = contextRes.value;
  const input = {
    ...checkpoint,
    agentConfiguration,
    conversationWindow: windowRes.value,
  };
  switch (input.lifecycleEvent) {
    case "before_model_call":
      return new Ok(input);
    case "after_model_call":
      return new Ok({
        ...input,
        modelOutput: await loadModelOutput(auth, {
          agentMessageModelId,
          step: input.step,
          dustRunId: input.dustRunId,
        }),
      });
    default:
      assertNever(input);
  }
}

async function loadConversationWindow({
  workspaceId,
  conversationId,
  agentMessageId,
  agentMessageVersion,
  step,
}: InferenceHookCheckpointRef): Promise<
  Result<ModelConversationTypeMultiActions, Error>
> {
  const checkpointRes = await loadConversationWindowCheckpoint({
    workspaceId,
    conversationId,
    agentMessageId,
    agentMessageVersion,
    step,
  });
  if (checkpointRes.isErr()) {
    return checkpointRes;
  }
  if (!checkpointRes.value) {
    return new Err(
      new DustError(
        "inference_hook_checkpoint_unavailable",
        `Conversation window checkpoint not found: ${agentMessageId} step ${step}`
      )
    );
  }

  return renderConversationWindowCheckpoint(checkpointRes.value);
}

async function loadHookContext(
  auth: Authenticator,
  checkpoint: InferenceHookCheckpointRef
): Promise<
  Result<
    {
      agentConfiguration: InferenceHookInput["agentConfiguration"];
      agentMessageModelId: ModelId;
    },
    Error
  >
> {
  const workspace = auth.getNonNullableWorkspace();
  if (checkpoint.workspaceId !== workspace.sId) {
    return new Err(
      new Error(
        `Checkpoint workspace does not match authenticated workspace: ${checkpoint.workspaceId}`
      )
    );
  }

  const conversation = await ConversationResource.fetchById(
    auth,
    checkpoint.conversationId
  );
  if (!conversation) {
    return new Err(
      new Error(`Conversation not found: ${checkpoint.conversationId}`)
    );
  }

  const messageRes = await conversation.getMessageById(
    auth,
    checkpoint.agentMessageId
  );
  if (messageRes.isErr()) {
    return new Err(
      new Error(`Agent message not found: ${checkpoint.agentMessageId}`)
    );
  }
  const messageRow = messageRes.value;
  const agentMessage = messageRow.agentMessage;
  if (!agentMessage) {
    return new Err(
      new Error(`Agent message not found: ${checkpoint.agentMessageId}`)
    );
  }
  if (messageRow.version !== checkpoint.agentMessageVersion) {
    return new Err(
      new Error(
        `Agent message version does not match checkpoint: ${checkpoint.agentMessageId}`
      )
    );
  }

  const configuration = await getPinnedAgentToolingForAgentMessage(auth, {
    agentVersion: agentMessage.agentConfigurationVersion,
    conversation,
    agentMessage: messageRow,
  });
  if (!configuration) {
    return new Err(
      new Error(
        `Agent configuration not found: ${agentMessage.agentConfigurationId}`
      )
    );
  }

  return new Ok({
    agentConfiguration: {
      sId: configuration.sId,
      name: configuration.name,
      description: configuration.description,
    },
    agentMessageModelId: agentMessage.id,
  });
}

async function loadModelOutput(
  auth: Authenticator,
  {
    agentMessageModelId,
    step,
    dustRunId,
  }: {
    agentMessageModelId: ModelId;
    step: number;
    dustRunId: string;
  }
): Promise<NormalizedModelOutput> {
  const stepContents =
    await AgentStepContentResource.fetchByAgentMessageModelIdsAtStepForRun(
      auth,
      {
        agentMessageModelIds: [agentMessageModelId],
        step,
        dustRunId,
      }
    );
  const contents = stepContents.flatMap((content) =>
    content.value.type === "error" ? [] : [content.value]
  );
  return {
    actions: contents.filter(isAgentFunctionCallContent).map((content) => ({
      functionCallId: content.value.id,
      name: content.value.name,
    })),
    generation: contents
      .filter(isAgentTextContent)
      .map((content) => content.value)
      .join(""),
    contents,
  };
}
