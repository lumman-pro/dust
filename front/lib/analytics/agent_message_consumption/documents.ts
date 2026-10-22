import { buildLlmConsumptionDocuments } from "@app/lib/analytics/agent_message_consumption/llm_documents";
import type { AgentMessageConsumptionAnalyticsInput } from "@app/lib/analytics/agent_message_consumption/load";
import { buildToolConsumptionDocuments } from "@app/lib/analytics/agent_message_consumption/tool_documents";
import type { AgentMessageConsumptionAnalyticsData } from "@app/types/assistant/analytics";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

export type ConsumptionDocumentsSkipReason =
  | {
      code: "credit_mismatch";
      context: {
        attributionVersion: number;
        indexedCreditMicro: number;
        reconciledCreditMicro: number;
        documentCount: number;
      };
    }
  | {
      code: "empty_documents";
      context: Record<string, never>;
    };

/**
 * Projects the reconciled attribution of one message into the document grain of the consumption
 * index: one LLM document per run usage and one tool document per action.
 *
 * Documents stay with the agent message and execution agent that incurred the cost. The separate
 * attributed agent identity rolls hidden helpers up to their user-facing parent for analytics.
 *
 * A regular tool document includes the cost of emitting its call, carrying its result into model
 * context, and its direct charge. Current attribution records a tool called through Computer with
 * only its direct charge because the parent Computer action owns the model-visible call and result
 * footprint.
 *
 * LLM documents receive the remaining model cost.
 */
/**
 * @cc [owner:sfriquet,label:product;backend] documents-add-up-to-reconciled-items
 * The documents' `credit_micro` MUST add up exactly to the reconciled amounts of the indexed items,
 * otherwise the result MUST be a `credit_mismatch` error and no document is returned. They MUST NOT
 * be compared with the message's current `costCredits`, which can be newer than the reconciliation.
 */
export function buildAgentMessageConsumptionAnalyticsDocuments(
  input: AgentMessageConsumptionAnalyticsInput
): Result<
  AgentMessageConsumptionAnalyticsData[],
  ConsumptionDocumentsSkipReason
> {
  const documents = [
    ...buildLlmConsumptionDocuments(input),
    ...buildToolConsumptionDocuments(input),
  ];

  const indexedCreditMicro = documents.reduce(
    (total, document) => total + document.credit_micro,
    0
  );
  const reconciledCreditMicro = input.items.reduce(
    (total, item) => total + item.reconciledCreditAmountMicro,
    0
  );
  if (indexedCreditMicro !== reconciledCreditMicro) {
    return new Err({
      code: "credit_mismatch",
      context: {
        attributionVersion: input.attributionVersion,
        indexedCreditMicro,
        reconciledCreditMicro,
        documentCount: documents.length,
      },
    });
  }

  return new Ok(documents);
}
