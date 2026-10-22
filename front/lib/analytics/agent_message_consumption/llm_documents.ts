import {
  makeBaseDocument,
  modelForUsage,
} from "@app/lib/analytics/agent_message_consumption/document_common";
import type {
  AgentMessageConsumptionAnalyticsInput,
  BilledRunUsage,
  ReconciledConsumptionItem,
} from "@app/lib/analytics/agent_message_consumption/load";
import {
  compareRunsChronologically,
  isUnavailableRunUsage,
} from "@app/lib/api/assistant/agent_message_consumption_attribution/allocation";
import type { AgentMessageModelConsumptionItemResource } from "@app/lib/resources/agent_message_consumption_item_resource";
import type {
  AgentMessageConsumptionAnalyticsLlmData,
  AgentMessageConsumptionAnalyticsLlmGrossCreditMicro,
  AgentMessageConsumptionAnalyticsLlmTokens,
} from "@app/types/assistant/analytics";
import type { ModelId } from "@app/types/shared/model_id";
import { assertNever } from "@app/types/shared/utils/assert_never";

function emptyTokens(): AgentMessageConsumptionAnalyticsLlmTokens {
  return {
    system: 0,
    input: 0,
    result_footprint: null,
    output: 0,
    reasoning: 0,
  };
}

function emptyGrossCredits(): AgentMessageConsumptionAnalyticsLlmGrossCreditMicro {
  return {
    system: 0,
    input: 0,
    result_footprint: null,
    output: 0,
    reasoning: 0,
    direct: 0,
    total: 0,
  };
}

// Match each model run to the step stored on its output content. If no content identifies the run,
// use its zero-based position among the message's runs in chronological order.
function stepIndexByRunModelId({
  runs,
  stepContents,
}: Pick<AgentMessageConsumptionAnalyticsInput, "runs" | "stepContents">): Map<
  ModelId,
  number
> {
  const fallbackStepByRunModelId = new Map(
    [...runs]
      .sort(compareRunsChronologically)
      .map((run, index) => [run.id, index])
  );
  const contentStepByDustRunId = new Map<string, number>();
  for (const content of stepContents) {
    if (content.dustRunId === null) {
      continue;
    }

    const current = contentStepByDustRunId.get(content.dustRunId);
    if (current === undefined || content.step < current) {
      contentStepByDustRunId.set(content.dustRunId, content.step);
    }
  }

  return new Map(
    runs.map((run) => [
      run.id,
      contentStepByDustRunId.get(run.dustRunId) ??
        fallbackStepByRunModelId.get(run.id) ??
        0,
    ])
  );
}

type ReconciledModelConsumptionItem = ReconciledConsumptionItem &
  AgentMessageModelConsumptionItemResource;

function modelItemsByRunUsageModelId(
  items: ReconciledConsumptionItem[]
): Map<ModelId, ReconciledModelConsumptionItem[]> {
  const itemsByRunUsageModelId = new Map<
    ModelId,
    ReconciledModelConsumptionItem[]
  >();

  for (const item of items) {
    if (!item.isModelItem()) {
      continue;
    }

    const usageItems = itemsByRunUsageModelId.get(item.runUsageId) ?? [];
    usageItems.push(item);
    itemsByRunUsageModelId.set(item.runUsageId, usageItems);
  }

  return itemsByRunUsageModelId;
}

function summarizeLlmConsumptionItems(
  items: ReconciledModelConsumptionItem[]
): Pick<
  AgentMessageConsumptionAnalyticsLlmData,
  "credit_micro" | "gross_credit_micro" | "tokens"
> {
  const tokens = emptyTokens();
  const grossCreditMicro = emptyGrossCredits();

  for (const item of items) {
    const creditMicro = item.reconciledCreditAmountMicro;

    switch (item.itemType) {
      case "system":
        tokens.system += item.inputTokensCount ?? 0;
        grossCreditMicro.system += creditMicro;
        break;

      case "input":
        tokens.input = (tokens.input ?? 0) + (item.inputTokensCount ?? 0);
        grossCreditMicro.input = (grossCreditMicro.input ?? 0) + creditMicro;
        break;

      case "output":
      case "reasoning":
        tokens[item.itemType] += item.outputTokensCount ?? 0;
        grossCreditMicro[item.itemType] += creditMicro;
        break;

      default:
        assertNever(item.itemType);
    }
  }

  grossCreditMicro.total =
    grossCreditMicro.system +
    (grossCreditMicro.input ?? 0) +
    grossCreditMicro.output +
    grossCreditMicro.reasoning;

  return {
    credit_micro: grossCreditMicro.total,
    gross_credit_micro: grossCreditMicro,
    tokens,
  };
}

function buildLlmConsumptionDocument({
  input,
  items,
  stepIndex,
  usage,
}: {
  input: AgentMessageConsumptionAnalyticsInput;
  items: ReconciledModelConsumptionItem[];
  stepIndex: number;
  usage: BilledRunUsage;
}): AgentMessageConsumptionAnalyticsLlmData {
  return {
    ...makeBaseDocument(input, {
      attributionVersion: input.attributionVersion,
      consumptionKey: `run-usage:${usage.runUsageModelId}`,
      runUsageModelId: usage.runUsageModelId,
      stepIndex,
      usageType: usage.usageType,
    }),
    ...summarizeLlmConsumptionItems(items),
    consumption_type: "llm",
    // The agent message stores only aggregate model latency, which cannot be split across runs.
    // TODO(2026-08-07 flav): Persist execution duration on each run and index it here.
    execution_time_ms: null,
    micro_usd: usage.costMicroUsd,
    model: modelForUsage(input.model, usage),
    status: input.messageStatus,
    tool: null,
  };
}

/**
 * @cc [owner:sfriquet,label:product;backend] no-llm-document-for-unavailable-usage
 * An `unavailable` run usage MUST NOT produce an LLM document.
 */
export function buildLlmConsumptionDocuments(
  input: AgentMessageConsumptionAnalyticsInput
): AgentMessageConsumptionAnalyticsLlmData[] {
  const itemsByUsageModelId = modelItemsByRunUsageModelId(input.items);
  const runUsageModelIdsWithItems = new Set(
    input.items.map((item) => item.runUsageId)
  );
  const stepByRunModelId = stepIndexByRunModelId(input);
  const documents: AgentMessageConsumptionAnalyticsLlmData[] = [];

  for (const usage of input.usages) {
    if (!runUsageModelIdsWithItems.has(usage.runUsageModelId)) {
      continue;
    }
    // An unavailable call was never billed and has no tokens: it is only kept so the tool calls
    // it emitted have a usage to hang from (see `isUnavailableRunUsage`).
    if (isUnavailableRunUsage(usage)) {
      continue;
    }

    documents.push(
      buildLlmConsumptionDocument({
        input,
        items: itemsByUsageModelId.get(usage.runUsageModelId) ?? [],
        stepIndex: stepByRunModelId.get(usage.runModelId) ?? 0,
        usage,
      })
    );
  }

  return documents;
}
