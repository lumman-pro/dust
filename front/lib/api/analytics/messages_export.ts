import { TOOL_NAME_SEPARATOR } from "@app/lib/actions/constants";
import { formatExportCellDateTime } from "@app/lib/api/analytics/csv_utils";
import {
  fetchAgentMetadata,
  fetchSpaceNames,
  fetchTagNames,
  fetchUserEmails,
} from "@app/lib/api/analytics/enrichment";
import { ExportLookupCache } from "@app/lib/api/analytics/export_lookup_cache";
import { resolveServerDisplayNames } from "@app/lib/api/assistant/observability/tool_usage";
import { buildAgentAnalyticsBaseQuery } from "@app/lib/api/assistant/observability/utils";
import type { ElasticsearchBaseDocument } from "@app/lib/api/elasticsearch";
import {
  bucketsToArray,
  searchAnalytics,
  searchConsumptionAnalytics,
} from "@app/lib/api/elasticsearch";
import type { Authenticator } from "@app/lib/auth";
import { microCreditsToCredits } from "@app/lib/credits/units";
import type {
  AgentMessageAnalyticsCost,
  AgentMessageAnalyticsModel,
} from "@app/types/assistant/analytics";
import { isModelId } from "@app/types/assistant/models/models";
import { isModelProviderId } from "@app/types/assistant/models/providers";
import {
  isReasoningEffort,
  normalizeLegacyReasoningEffort,
} from "@app/types/assistant/models/reasoning";
import { isModelResolutionMethod } from "@app/types/assistant/models/types";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";
import type { WorkspaceType } from "@app/types/user";
import type { estypes } from "@elastic/elasticsearch";
import { buildConsumptionScopeQuery } from "./consumption/scope";

const PAGE_SIZE = 10000;

interface AgentMessageDocument extends ElasticsearchBaseDocument {
  message_id: string;
  timestamp: string;
  agent_id: string;
  // Optional: docs indexed before agent_tag_ids shipped don't carry it.
  agent_tag_ids?: string[];
  conversation_id: string;
  // Optional: docs indexed before space_id shipped don't carry it.
  space_id?: string | null;
  // Ids of the agent messages that triggered this message through `run_agent`,
  // direct parent first. Empty or absent for user-initiated messages.
  ancestor_message_ids?: string[];
  user_id: string;
  context_origin: string;
  status: string;
  tools_used?: { server_name: string; tool_name: string }[];
  skills_used?: { skill_name: string }[];
  // Optional: docs indexed before the cost fields shipped don't carry it.
  cost?: AgentMessageAnalyticsCost;
  // Optional: docs indexed before the model fields shipped don't carry it.
  model?: AgentMessageAnalyticsModel | null;
}

export interface MessageExportRow {
  messageId: string;
  createdAt: string;
  assistantId: string;
  assistantName: string;
  assistantSettings: string;
  assistantTags: string;
  conversationId: string;
  spaceId: string;
  spaceName: string;
  parentMessageId: string;
  userId: string;
  userEmail: string;
  source: string;
  toolsUsed: string;
  skillsUsed: string;
  modelId: string;
  modelProviderId: string;
  modelResolutionMethod: string;
  credits: number;
}

export const MESSAGE_EXPORT_HEADERS: (keyof MessageExportRow)[] = [
  "messageId",
  "createdAt",
  "assistantId",
  "assistantName",
  "assistantSettings",
  "assistantTags",
  "conversationId",
  "spaceId",
  "spaceName",
  "parentMessageId",
  "userId",
  "userEmail",
  "source",
  "toolsUsed",
  "skillsUsed",
  "modelId",
  "modelProviderId",
  "modelResolutionMethod",
  "credits",
];

function joinDistinctSorted(values: (string | undefined | null)[]): string {
  return [...new Set(values.filter((v): v is string => Boolean(v)))]
    .sort((a, b) => a.localeCompare(b))
    .join(",");
}

async function* generateMessageDocumentPages(
  query: estypes.QueryDslQueryContainer
): AsyncGenerator<Result<AgentMessageDocument[], Error>> {
  let searchAfter: estypes.SortResults | undefined;

  while (true) {
    const result = await searchAnalytics<AgentMessageDocument>(query, {
      size: PAGE_SIZE,
      sort: [{ timestamp: "asc" }, { message_id: "asc" }],
      search_after: searchAfter,
    });

    if (result.isErr()) {
      yield new Err(new Error(result.error.message));
      return;
    }

    const { hits } = result.value.hits;
    yield new Ok(removeNulls(hits.map((hit) => hit._source)));

    if (hits.length < PAGE_SIZE) {
      return;
    }

    const lastHit = hits[hits.length - 1];
    searchAfter = lastHit.sort;
  }
}

// Limit page size so we don't exceed the 65536 bucket limits.
const CONSUMPTION_AGG_PAGE_SIZE = 5000;

type TermsAgg =
  estypes.AggregationsTermsAggregateBase<estypes.AggregationsStringTermsBucketKeys>;

interface ConsumptionMessageBucket {
  key: Record<string, string>;
  doc_count: number;
  min_completed_at: estypes.AggregationsMinAggregate;
  agent_id: TermsAgg;
  agent_tag_ids: TermsAgg;
  conversation_id: TermsAgg;
  space_id: TermsAgg;
  parent_message_id: TermsAgg;
  user_id: TermsAgg;
  context_origin: TermsAgg;
  total_credit_micro: estypes.AggregationsSumAggregate;
  tools: estypes.AggregationsFilterAggregate & {
    unique_tools: estypes.AggregationsMultiTermsAggregate;
  };
  skills: TermsAgg;
  models: estypes.AggregationsMultiTermsAggregate;
}

interface ConsumptionMessageAggs {
  by_message: estypes.AggregationsTermsAggregateBase<ConsumptionMessageBucket> & {
    after_key?: Record<string, string>;
  };
}

function buildConsumptionAggregations(
  afterKey?: Record<string, string>
): Record<string, estypes.AggregationsAggregationContainer> {
  return {
    by_message: {
      composite: {
        size: CONSUMPTION_AGG_PAGE_SIZE,
        sources: [
          { agent_message_id: { terms: { field: "agent_message_id" } } },
        ],
        ...(afterKey ? { after: afterKey } : {}),
      },
      // Group all LLM calls and tool calls by agent_message_id:
      // reconstruct the message-level document from the aggregated fields.
      aggs: {
        min_completed_at: { min: { field: "completed_at" } },
        agent_id: {
          // agent_id is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "agent.id",
            size: 1,
          },
        },
        agent_tag_ids: {
          // agent_tag_ids is denormalized on every tool/llm calls: we expect a single set of values per message.
          terms: {
            field: "agent.tag_ids",
            size: 100, // keep at most 100 unique tag IDs per message.
          },
        },
        space_id: {
          // space_id is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "space_id",
            size: 1,
          },
        },
        parent_message_id: {
          // parent_message_id is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "parent_message_id",
            size: 1,
          },
        },
        conversation_id: {
          // conversation_id is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "conversation_id",
            size: 1,
          },
        },
        user_id: {
          // user_id is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "user.id",
            size: 1,
          },
        },
        context_origin: {
          // context_origin is denormalized on every tool/llm calls: keep a single value per message.
          terms: {
            field: "context_origin",
            size: 1,
          },
        },
        total_credit_micro: { sum: { field: "credit_micro" } },
        tools: {
          // Distinct pairs found across all tool calls, capped at 100 values.
          filter: { exists: { field: "tool.name" } },
          aggs: {
            unique_tools: {
              multi_terms: {
                terms: [{ field: "tool.server_name" }, { field: "tool.name" }],
                size: 100,
              },
            },
          },
        },
        skills: {
          // Distinct skill ids from this message, capped at 100 values.
          terms: {
            field: "tool.attributed_skill_ids",
            size: 100,
          },
        },
        models: {
          // Distinct tuples found across all LLM and tool calls, capped at 10 values.
          // In practice models don't change between runs today.
          multi_terms: {
            terms: [
              { field: "model.model_id" },
              { field: "model.provider_id" },
              { field: "model.resolution_method" },
              { field: "model.reasoning_effort" },
            ],
            size: 10,
          },
        },
      },
    },
  };
}

function firstBucketKey(agg: TermsAgg | undefined): string {
  const buckets = bucketsToArray(agg?.buckets);
  return buckets[0]?.key ?? "";
}

function parseAnalyticsModel(
  bucket: estypes.AggregationsStringTermsBucketKeys | undefined
): AgentMessageAnalyticsModel | null {
  if (!bucket) {
    return null;
  }
  const modelId = String(bucket.key[0]);
  const providerId = String(bucket.key[1]);
  const resolutionMethod = String(bucket.key[2]);
  const reasoningEffort = normalizeLegacyReasoningEffort(String(bucket.key[3]));

  if (
    !isModelId(modelId) ||
    !isModelProviderId(providerId) ||
    !isReasoningEffort(reasoningEffort)
  ) {
    return null;
  }

  return {
    model_id: modelId,
    provider_id: providerId,
    resolution_method: isModelResolutionMethod(resolutionMethod)
      ? resolutionMethod
      : null,
    reasoning_effort: reasoningEffort,
  };
}

function consumptionBucketToDocument(
  messageId: string,
  bucket: ConsumptionMessageBucket
): AgentMessageDocument {
  const toolBuckets = bucketsToArray(bucket.tools?.unique_tools?.buckets);

  const skillBuckets = bucketsToArray(bucket.skills?.buckets);

  const modelBuckets = bucketsToArray(bucket.models?.buckets);
  const primaryModel = modelBuckets[0];

  const creditMicro = bucket.total_credit_micro.value ?? 0;

  return {
    workspace_id: "", // not used by csv export and not fetched by the es aggregation
    message_id: messageId,
    timestamp: bucket.min_completed_at.value_as_string ?? "",
    agent_id: firstBucketKey(bucket.agent_id),
    agent_tag_ids: bucketsToArray(bucket.agent_tag_ids?.buckets).map(
      (b) => b.key
    ),
    conversation_id: firstBucketKey(bucket.conversation_id),
    space_id: firstBucketKey(bucket.space_id),
    ancestor_message_ids: firstBucketKey(bucket.parent_message_id)
      ? [firstBucketKey(bucket.parent_message_id)]
      : [],
    user_id: firstBucketKey(bucket.user_id),
    context_origin: firstBucketKey(bucket.context_origin),
    status: "", // not used by csv export and not fetched by the es aggregation
    tools_used: toolBuckets.map((b) => ({
      server_name: String(b.key[0]),
      tool_name: String(b.key[1]),
    })),
    skills_used: skillBuckets.map((b) => ({
      skill_name: b.key,
    })),
    cost: {
      full_awu: 0,
      llm_awu: 0,
      tool_awu: 0,
      billable_awu: Math.round(microCreditsToCredits(creditMicro)),
    },
    model: parseAnalyticsModel(primaryModel),
  };
}

async function* generateConsumptionMessageDocumentPages(
  auth: Authenticator,
  startDate: string,
  endDate: string
): AsyncGenerator<Result<AgentMessageDocument[], Error>> {
  const query = buildConsumptionScopeQuery({
    auth,
    startDate,
    endDate,
  });

  let afterKey: Record<string, string> | undefined;

  while (true) {
    const result = await searchConsumptionAnalytics<
      never,
      ConsumptionMessageAggs
    >(query, {
      aggregations: buildConsumptionAggregations(afterKey),
      size: 0,
    });

    if (result.isErr()) {
      yield new Err(new Error(result.error.message));
      return;
    }

    const byMessage = result.value.aggregations?.by_message;
    if (!byMessage) {
      yield new Ok([]);
      return;
    }

    const buckets = bucketsToArray(
      byMessage.buckets
    ) as ConsumptionMessageBucket[];

    yield new Ok(
      buckets.map((bucket) =>
        consumptionBucketToDocument(bucket.key.agent_message_id, bucket)
      )
    );

    if (buckets.length < CONSUMPTION_AGG_PAGE_SIZE) {
      return;
    }

    afterKey = buckets[buckets.length - 1].key;
  }
}

/**
 * @cc [owner:tdraier,label:performance] page-bounded-memory
 * Each yielded page MUST be built from a single Elasticsearch page, and documents or rows of
 * previously yielded pages MUST NOT be retained. Only the agent, user, tag, server and space
 * lookups MAY be kept across pages. After yielding an `Err`, the generator MUST stop.
 */
export async function* generateMessageExportRows({
  auth,
  owner,
  startDate,
  endDate,
  timezone,
  useConsumptionIndex = false,
}: {
  auth: Authenticator;
  owner: WorkspaceType;
  startDate: string;
  endDate: string;
  timezone: string;
  useConsumptionIndex?: boolean;
}): AsyncGenerator<Result<MessageExportRow[], Error>> {
  const documentPages = useConsumptionIndex
    ? generateConsumptionMessageDocumentPages(auth, startDate, endDate)
    : generateMessageDocumentPages(
        buildAgentAnalyticsBaseQuery({
          workspaceId: owner.sId,
          startDate,
          endDate,
        })
      );

  const agentMeta = new ExportLookupCache((ids) =>
    fetchAgentMetadata(ids, owner)
  );
  const userEmails = new ExportLookupCache(fetchUserEmails);
  const tagNames = new ExportLookupCache((ids) => fetchTagNames(auth, ids));
  const serverDisplayNames = new ExportLookupCache((names) =>
    resolveServerDisplayNames(auth, names)
  );
  const spaceNames = new ExportLookupCache((ids) => fetchSpaceNames(auth, ids));

  for await (const page of documentPages) {
    if (page.isErr()) {
      yield new Err(page.error);
      return;
    }

    const docs = page.value;

    await Promise.all([
      agentMeta.load(docs.map((d) => d.agent_id)),
      userEmails.load(docs.map((d) => d.user_id)),
      tagNames.load(docs.flatMap((d) => d.agent_tag_ids ?? [])),
      serverDisplayNames.load(
        docs.flatMap((d) => (d.tools_used ?? []).map((t) => t.server_name))
      ),
      spaceNames.load(removeNulls(docs.map((d) => d.space_id))),
    ]);

    const rows: MessageExportRow[] = docs.map((doc) => {
      const agent = agentMeta.get(doc.agent_id);
      return {
        messageId: doc.message_id,
        createdAt: formatExportCellDateTime(doc.timestamp, timezone),
        assistantId: doc.agent_id,
        assistantName: agent?.name ?? doc.agent_id,
        assistantSettings: agent?.settings ?? "unknown",
        assistantTags: joinDistinctSorted(
          (doc.agent_tag_ids ?? []).map((id) => tagNames.get(id))
        ),
        conversationId: doc.conversation_id,
        spaceId: doc.space_id ?? "",
        spaceName: doc.space_id ? (spaceNames.get(doc.space_id) ?? "") : "",
        parentMessageId: doc.ancestor_message_ids?.[0] ?? "",
        userId: doc.user_id,
        userEmail: userEmails.get(doc.user_id) ?? "",
        source: doc.context_origin ?? "",
        toolsUsed: joinDistinctSorted(
          (doc.tools_used ?? []).map(
            (t) =>
              `${serverDisplayNames.get(t.server_name) ?? t.server_name}${TOOL_NAME_SEPARATOR}${t.tool_name}`
          )
        ),
        skillsUsed: joinDistinctSorted(
          (doc.skills_used ?? []).map((s) => s.skill_name)
        ),
        modelId: doc.model?.model_id ?? "",
        modelProviderId: doc.model?.provider_id ?? "",
        modelResolutionMethod: doc.model?.resolution_method ?? "",
        credits: Math.round(doc.cost?.billable_awu ?? 0),
      };
    });

    yield new Ok(rows);
  }
}
