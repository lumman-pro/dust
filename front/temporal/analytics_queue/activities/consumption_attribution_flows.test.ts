import { upsertAgentMessageConsumptionAnalyticsDocuments } from "@app/lib/analytics/agent_message_consumption/store";
import { AGENT_MESSAGE_CONSUMPTION_ATTRIBUTION_VERSION } from "@app/lib/api/assistant/agent_message_consumption_attribution/attribution_builder";
import { getLlmCredentials } from "@app/lib/api/provider_credentials";
import type { Authenticator } from "@app/lib/auth";
import { buildAgentMessageBillingPlan } from "@app/lib/credits/agent_message_billing";
import { USAGE_TYPE_FREE } from "@app/lib/metronome/constants";
import type { UsageType } from "@app/lib/metronome/types";
import { AgentMessageModel } from "@app/lib/models/agent/conversation";
import { AgentMessageConsumptionItemResource } from "@app/lib/resources/agent_message_consumption_item_resource";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { RunResource } from "@app/lib/resources/run_resource";
import { tokenCountForTexts } from "@app/lib/tokenization";
import {
  storeAgentMessageConsumptionAnalyticsActivity,
  storeAgentMessageConsumptionAttributionForMessageActivity,
} from "@app/temporal/analytics_queue/activities/consumption_attribution";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import {
  GPT_5_MINI_TOKENS_PER_CREDIT,
  RunFactory,
} from "@app/tests/utils/RunFactory";
import type { AgentMessageRef } from "@app/types/assistant/agent_run";
import type { UserMessageOrigin } from "@app/types/assistant/conversation";
import { GPT_5_MINI_MODEL_CONFIG } from "@app/types/assistant/models/openai";
import { Ok } from "@app/types/shared/result";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/analytics/agent_message_consumption/store", () => ({
  upsertAgentMessageConsumptionAnalyticsDocuments: vi.fn(),
}));

vi.mock("@app/lib/api/assistant/streaming/events", () => ({
  publishConversationRelatedEvent: vi.fn(),
}));

vi.mock("@app/lib/api/provider_credentials", () => ({
  getLlmCredentials: vi.fn(),
}));

vi.mock("@app/lib/tokenization", () => ({
  tokenCountForTexts: vi.fn(),
}));

const { input: INPUT, output: OUTPUT } = GPT_5_MINI_TOKENS_PER_CREDIT;

// Replays the consumption attribution workflow on the real data: the attribution activity, then
// the analytics activity, with only Elasticsearch mocked.
async function setupPausedMessage({
  origin,
  usageType,
}: { origin?: UserMessageOrigin; usageType?: UsageType } = {}) {
  const { authenticator: auth, workspace } = await createResourceTest({
    role: "admin",
  });
  const agent = await AgentConfigurationFactory.createTestAgent(auth);
  const conversationType = await ConversationFactory.create(auth, {
    agentConfigurationId: agent.sId,
    messagesCreatedAt: [],
  });
  const conversation = await ConversationResource.fetchById(
    auth,
    conversationType.sId
  );
  if (!conversation) {
    throw new Error("Conversation was not created");
  }
  const userMessage = await ConversationFactory.createUserMessageWithRank({
    auth,
    workspace,
    conversationId: conversation.id,
    rank: 0,
    content: "Hello",
    ...(origin ? { origin } : {}),
  });
  // The factory status is "created": the loop is paused, e.g. on a user question.
  const agentMessage = await ConversationFactory.createAgentMessageWithRank({
    workspace,
    conversationId: conversation.id,
    rank: 1,
    parentId: userMessage.id,
    agentConfigurationId: agent.sId,
    agentConfigurationVersion: agent.version,
    resolvedModel: {
      providerId: GPT_5_MINI_MODEL_CONFIG.providerId,
      modelId: GPT_5_MINI_MODEL_CONFIG.modelId,
      reasoningEffort: "none",
    },
    modelResolutionMethod: "agent",
  });
  const agentMessageModelId = agentMessage.agentMessageId;
  if (!agentMessageModelId) {
    throw new Error("Agent message was not created");
  }

  const { run } = await RunFactory.createWithUsage(auth, {
    inputTokens: INPUT,
    outputTokens: 4 * OUTPUT,
    modelId: GPT_5_MINI_MODEL_CONFIG.modelId,
    usageType,
  });
  const runs: RunResource[] = [run];
  await AgentMessageModel.update(
    { runIds: [run.dustRunId] },
    { where: { id: agentMessageModelId, workspaceId: workspace.id } }
  );

  const message: AgentMessageRef = {
    agentMessageId: agentMessage.sId,
    conversationId: conversation.sId,
  };

  return {
    agentMessageModelId,
    auth,
    authType: auth.toJSON(),
    message,
    runs,
    workspace,
  };
}

type PausedMessage = Awaited<ReturnType<typeof setupPausedMessage>>;

// Bills the message from its runs as finalize does, and returns the bill in micro credits.
async function billMessage(
  auth: Authenticator,
  {
    agentMessageModelId,
    contextOrigin = "web",
    runs,
  }: {
    agentMessageModelId: number;
    contextOrigin?: UserMessageOrigin;
    runs: RunResource[];
  }
): Promise<number> {
  const { billedCredits } = buildAgentMessageBillingPlan({
    actions: [],
    contextOrigin,
    runUsages: await RunResource.listRunUsagesForRuns(auth, { runs }),
  }).totals;
  await ConversationResource.updateAgentMessageCostCredits(auth, {
    agentMessageModelId,
    costCredits: billedCredits,
  });
  return billedCredits * 1_000_000;
}

// A model call whose usage is not reported is closed as `unavailable`, e.g. when it fails.
async function runAnotherModelCall(
  message: PausedMessage,
  { reported }: { reported: boolean }
): Promise<void> {
  const { run } = reported
    ? await RunFactory.createWithUsage(message.auth, {
        inputTokens: INPUT,
        outputTokens: 4 * OUTPUT,
        modelId: GPT_5_MINI_MODEL_CONFIG.modelId,
      })
    : await RunFactory.createWithUnavailableUsage(message.auth);
  message.runs.push(run);
  await AgentMessageModel.update(
    { runIds: message.runs.map(({ dustRunId }) => dustRunId) },
    {
      where: {
        id: message.agentMessageModelId,
        workspaceId: message.workspace.id,
      },
    }
  );
}

async function runAttributionPass({ authType, message }: PausedMessage) {
  await storeAgentMessageConsumptionAttributionForMessageActivity(authType, {
    message,
  });
  await storeAgentMessageConsumptionAnalyticsActivity(authType, { message });
}

function indexedCreditMicro(): number {
  const documents = vi.mocked(upsertAgentMessageConsumptionAnalyticsDocuments)
    .mock.lastCall?.[0];
  if (!documents) {
    throw new Error("No consumption document was indexed");
  }
  return documents.reduce(
    (total, document) => total + document.credit_micro,
    0
  );
}

async function listItems({ auth, agentMessageModelId }: PausedMessage) {
  return AgentMessageConsumptionItemResource.listByAgentMessageModelIds(auth, {
    agentMessageModelIds: [agentMessageModelId],
    maxAttributionVersion: AGENT_MESSAGE_CONSUMPTION_ATTRIBUTION_VERSION,
  });
}

describe("consumption attribution workflow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getLlmCredentials).mockResolvedValue({});
    vi.mocked(tokenCountForTexts).mockImplementation(
      async (texts) => new Ok(texts.map(() => 2))
    );
    vi.mocked(
      upsertAgentMessageConsumptionAnalyticsDocuments
    ).mockResolvedValue(new Ok(undefined));
  });

  it("indexes the reconciled snapshot when the message resumed between the two activities", async () => {
    const message = await setupPausedMessage();
    const pausedBillMicro = await billMessage(message.auth, message);

    await storeAgentMessageConsumptionAttributionForMessageActivity(
      message.authType,
      { message: message.message }
    );

    // The user answers: the loop resumes, reports another model call and finalizes again before
    // the analytics activity of the first pass runs.
    await runAnotherModelCall(message, { reported: true });
    const finalBillMicro = await billMessage(message.auth, message);
    expect(finalBillMicro).toBeGreaterThan(pausedBillMicro);

    await storeAgentMessageConsumptionAnalyticsActivity(message.authType, {
      message: message.message,
    });
    expect(indexedCreditMicro()).toBe(pausedBillMicro);

    // The second finalize signal makes the workflow run another pass.
    await runAttributionPass(message);
    expect(indexedCreditMicro()).toBe(finalBillMicro);
  });

  it("writes and indexes nothing for a sidekick message, whose free usage is not billed", async () => {
    const message = await setupPausedMessage({
      origin: "agent_sidekick",
      usageType: USAGE_TYPE_FREE,
    });
    expect(
      await billMessage(message.auth, {
        ...message,
        contextOrigin: "agent_sidekick",
      })
    ).toBe(0);

    await runAttributionPass(message);

    expect(await listItems(message)).toHaveLength(0);
    expect(
      upsertAgentMessageConsumptionAnalyticsDocuments
    ).not.toHaveBeenCalled();
  });

  it("indexes the bill a failed message kept when it failed before the attribution activity ran", async () => {
    const message = await setupPausedMessage();
    const pausedBillMicro = await billMessage(message.auth, message);

    // The user answers and the loop resumes, but its model call fails: the message ends `failed`
    // and billing leaves its bill unchanged, all before the attribution activity of the pause runs.
    await runAnotherModelCall(message, { reported: false });
    await AgentMessageModel.update(
      { completedAt: new Date(), status: "failed" },
      {
        where: {
          id: message.agentMessageModelId,
          workspaceId: message.workspace.id,
        },
      }
    );

    await runAttributionPass(message);

    expect(indexedCreditMicro()).toBe(pausedBillMicro);
  });
});
