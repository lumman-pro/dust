import type { ConsumptionDocumentsSkipReason } from "@app/lib/analytics/agent_message_consumption/documents";
import { buildAgentMessageConsumptionAnalyticsDocuments } from "@app/lib/analytics/agent_message_consumption/documents";
import { loadAgentMessageConsumptionAnalyticsInput } from "@app/lib/analytics/agent_message_consumption/load";
import { upsertAgentMessageConsumptionAnalyticsDocuments } from "@app/lib/analytics/agent_message_consumption/store";
import type { ElasticsearchError } from "@app/lib/api/elasticsearch";
import type { Authenticator } from "@app/lib/auth";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";

/**
 * Loads, projects, and indexes the complete consumption analytics snapshot for one agent message.
 */
export async function indexAgentMessageConsumptionAnalytics(
  auth: Authenticator,
  { agentMessageId }: { agentMessageId: string }
): Promise<Result<void, ElasticsearchError | ConsumptionDocumentsSkipReason>> {
  const input = await loadAgentMessageConsumptionAnalyticsInput(auth, {
    agentMessageId,
  });
  if (!input) {
    return new Ok(undefined);
  }

  const documentsResult = buildAgentMessageConsumptionAnalyticsDocuments(input);
  if (documentsResult.isErr()) {
    return documentsResult;
  }
  if (documentsResult.value.length === 0) {
    return new Err({ code: "empty_documents", context: {} });
  }

  return upsertAgentMessageConsumptionAnalyticsDocuments(documentsResult.value);
}
