import type { DimensionLabel } from "@app/lib/api/analytics/consumption/labels";
import { resolveDimensionLabels } from "@app/lib/api/analytics/consumption/labels";
import type { ConsumptionPeriod } from "@app/lib/api/analytics/consumption/period";
import type {
  ConsumptionScopeFilter,
  ConsumptionTopDimension,
} from "@app/lib/api/analytics/consumption/scope";
import { buildConsumptionScopeQuery } from "@app/lib/api/analytics/consumption/scope";
import {
  roundToTwoDecimals,
  rowsToCsv,
} from "@app/lib/api/analytics/csv_utils";
import { fetchSpaceNames } from "@app/lib/api/analytics/enrichment";
import { ExportLookupCache } from "@app/lib/api/analytics/export_lookup_cache";
import type { ElasticsearchError } from "@app/lib/api/elasticsearch";
import { searchConsumptionAnalytics } from "@app/lib/api/elasticsearch";
import type { Authenticator } from "@app/lib/auth";
import { microCreditsToCredits } from "@app/lib/credits/units";
import logger from "@app/logger/logger";
import type { AgentMessageConsumptionAnalyticsData } from "@app/types/assistant/analytics";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { removeNulls } from "@app/types/shared/utils/general";
import { asyncGeneratorToReadableStream } from "@app/types/shared/utils/streams";
import type { estypes } from "@elastic/elasticsearch";

const EXPORT_PAGE_SIZE = 10_000;

type ConsumptionLineExportRow = {
  completedAt: string;
  conversationId: string;
  spaceId: string;
  spaceName: string;
  agentMessageId: string;
  consumptionType: string;
  agentId: string;
  agentName: string;
  agentVersion: string;
  agentTagIds: string;
  agentRootId: string;
  agentParentId: string;
  agentDepth: number;
  modelProviderId: string;
  modelId: string;
  modelName: string;
  modelReasoningEffort: string;
  modelResolutionMethod: string;
  userId: string;
  userName: string;
  userGroupIds: string;
  userGroupNames: string;
  triggerId: string;
  triggerName: string;
  contextOrigin: string;
  apiKeyName: string;
  toolName: string;
  toolServerName: string;
  toolDisplayName: string;
  toolParentServerName: string;
  toolActionId: string;
  attributedSkillIds: string;
  attributedSkillNames: string;
  creditsSystem: number;
  creditsInput: number;
  creditsOutput: number;
  creditsReasoning: number;
  creditsAction: number;
  totalCredits: number;
  usageType: string;
  status: string;
  stepIndex: number;
  executionTimeMs: number;
};

const CONSUMPTION_LINE_EXPORT_HEADERS: (keyof ConsumptionLineExportRow)[] = [
  "completedAt",
  "conversationId",
  "spaceId",
  "spaceName",
  "agentMessageId",
  "consumptionType",
  "agentId",
  "agentName",
  "agentVersion",
  "agentTagIds",
  "agentRootId",
  "agentParentId",
  "agentDepth",
  "modelProviderId",
  "modelId",
  "modelName",
  "modelReasoningEffort",
  "modelResolutionMethod",
  "userId",
  "userName",
  "userGroupIds",
  "userGroupNames",
  "triggerId",
  "triggerName",
  "contextOrigin",
  "apiKeyName",
  "toolName",
  "toolServerName",
  "toolDisplayName",
  "toolParentServerName",
  "toolActionId",
  "attributedSkillIds",
  "attributedSkillNames",
  "creditsSystem",
  "creditsInput",
  "creditsOutput",
  "creditsReasoning",
  "creditsAction",
  "totalCredits",
  "usageType",
  "status",
  "stepIndex",
  "executionTimeMs",
];

const ES_SORT: estypes.Sort = [
  { completed_at: "asc" },
  { agent_message_id: "asc" },
  { consumption_key: "asc" },
];

class DimensionLabelCache {
  private readonly cacheByDimension = new Map<
    ConsumptionTopDimension,
    ExportLookupCache<DimensionLabel>
  >();

  async resolve(
    auth: Authenticator,
    dimension: ConsumptionTopDimension,
    keys: string[]
  ): Promise<ExportLookupCache<DimensionLabel>> {
    let cache = this.cacheByDimension.get(dimension);
    if (!cache) {
      cache = new ExportLookupCache((ids) =>
        resolveDimensionLabels(auth, dimension, ids)
      );
      this.cacheByDimension.set(dimension, cache);
    }

    await cache.load(keys);
    return cache;
  }

  private spaceNames: ExportLookupCache<string> | undefined;

  async resolveSpaceNames(
    auth: Authenticator,
    spaceIds: string[]
  ): Promise<ExportLookupCache<string>> {
    if (!this.spaceNames) {
      this.spaceNames = new ExportLookupCache((ids) =>
        fetchSpaceNames(auth, ids)
      );
    }

    await this.spaceNames.load(spaceIds);
    return this.spaceNames;
  }
}

// `visibleGroupIds` restricts the user group columns to those groups (group sIds); every group of
// the user is listed when it is omitted.
async function buildConsumptionLineExportRows(
  auth: Authenticator,
  docs: AgentMessageConsumptionAnalyticsData[],
  {
    labelCache,
    visibleGroupIds,
  }: {
    labelCache?: DimensionLabelCache;
    visibleGroupIds?: ReadonlySet<string>;
  } = {}
): Promise<ConsumptionLineExportRow[]> {
  const userGroupIds: (doc: AgentMessageConsumptionAnalyticsData) => string[] =
    visibleGroupIds
      ? (doc) =>
          (doc.user?.group_ids ?? []).filter((groupId) =>
            visibleGroupIds.has(groupId)
          )
      : (doc) => doc.user?.group_ids ?? [];

  const resolve = labelCache
    ? (dimension: ConsumptionTopDimension, keys: string[]) =>
        labelCache.resolve(auth, dimension, keys)
    : (dimension: ConsumptionTopDimension, keys: string[]) =>
        resolveDimensionLabels(auth, dimension, keys);
  const resolveSpaceNames = labelCache
    ? (spaceIds: string[]) => labelCache.resolveSpaceNames(auth, spaceIds)
    : (spaceIds: string[]) => fetchSpaceNames(auth, spaceIds);

  const [
    agentLabels,
    userLabels,
    modelLabels,
    toolLabels,
    skillLabels,
    groupLabels,
    sourceLabels,
    triggerLabels,
    spaceNames,
  ] = await Promise.all([
    resolve("agent", [...new Set(docs.map((doc) => doc.agent.attributed_id))]),
    resolve("user", [...new Set(removeNulls(docs.map((doc) => doc.user?.id)))]),
    resolve("model", [
      ...new Set(removeNulls(docs.map((doc) => doc.model?.model_id))),
    ]),
    resolve("tool", [
      ...new Set(removeNulls(docs.map((doc) => doc.tool?.server_name))),
    ]),
    resolve("skill", [
      ...new Set(docs.flatMap((doc) => doc.tool?.attributed_skill_ids ?? [])),
    ]),
    resolve("group", [...new Set(docs.flatMap(userGroupIds))]),
    resolve("source", [
      ...new Set(removeNulls(docs.map((doc) => doc.context_origin))),
    ]),
    resolve("trigger", [
      ...new Set(removeNulls(docs.map((doc) => doc.trigger_id))),
    ]),
    resolveSpaceNames([
      ...new Set(removeNulls(docs.map((doc) => doc.space_id))),
    ]),
  ]);

  return docs.map((doc) => {
    const { agent, model, user, tool } = doc;
    const groupIds = userGroupIds(doc);
    const agentId = agent.attributed_id;
    // Older documents indexed before these buckets shipped don't carry them.
    const gross = doc.gross_credit_micro ?? {
      system: 0,
      input: null,
      result_footprint: null,
      output: null,
      reasoning: 0,
      direct: 0,
      total: 0,
    };

    return {
      completedAt: doc.completed_at,
      conversationId: doc.conversation_id,
      spaceId: doc.space_id ?? "",
      spaceName: doc.space_id ? (spaceNames.get(doc.space_id) ?? "") : "",
      agentMessageId: doc.agent_message_id,
      consumptionType: doc.consumption_type,
      agentId,
      agentName: agentLabels.get(agentId)?.name ?? agentId,
      agentVersion: agent.version ?? "",
      agentTagIds: (agent.tag_ids ?? []).join("; "),
      agentRootId: agent.root_id ?? "",
      agentParentId: agent.direct_parent_id ?? "",
      agentDepth: agent.depth ?? 0,
      modelProviderId: model?.provider_id ?? "",
      modelId: model?.model_id ?? "",
      modelName: model
        ? (modelLabels.get(model.model_id)?.name ?? model.model_id)
        : "",
      modelReasoningEffort: model?.reasoning_effort ?? "",
      modelResolutionMethod: model?.resolution_method ?? "",
      userId: user?.id ?? "",
      userName: user ? (userLabels.get(user.id)?.name ?? user.id) : "",
      userGroupIds: groupIds.join("; "),
      userGroupNames: groupIds
        .map((id) => groupLabels.get(id)?.name ?? id)
        .join("; "),
      triggerId: doc.trigger_id ?? "",
      triggerName: doc.trigger_id
        ? (triggerLabels.get(doc.trigger_id)?.name ?? doc.trigger_id)
        : "",
      contextOrigin: doc.context_origin
        ? (sourceLabels.get(doc.context_origin)?.name ?? doc.context_origin)
        : "",
      apiKeyName: doc.api_key_name ?? "",
      toolName: tool?.name ?? "",
      toolServerName: tool?.server_name ?? "",
      toolDisplayName: tool
        ? (toolLabels.get(tool.server_name)?.name ?? tool.server_name)
        : "",
      toolParentServerName: tool?.parent_server_name ?? "",
      toolActionId: tool?.action_id ?? "",
      attributedSkillIds: (tool?.attributed_skill_ids ?? []).join("; "),
      attributedSkillNames: (tool?.attributed_skill_ids ?? [])
        .map((id) => skillLabels.get(id)?.name ?? id)
        .join("; "),
      creditsSystem: roundToTwoDecimals(
        microCreditsToCredits(gross.system ?? 0)
      ),
      creditsInput: roundToTwoDecimals(microCreditsToCredits(gross.input ?? 0)),
      creditsOutput: roundToTwoDecimals(
        microCreditsToCredits(gross.output ?? 0)
      ),
      creditsReasoning: roundToTwoDecimals(
        microCreditsToCredits(gross.reasoning ?? 0)
      ),
      creditsAction: roundToTwoDecimals(
        microCreditsToCredits(gross.direct ?? 0)
      ),
      totalCredits: roundToTwoDecimals(microCreditsToCredits(doc.credit_micro)),
      usageType: doc.usage_type,
      status: doc.status,
      stepIndex: doc.step_index,
      executionTimeMs: doc.execution_time_ms ?? 0,
    };
  });
}

// Yields the consumption lines for one period (typically a bucket of a larger export) as
// headerless CSV, one ES page per chunk, so memory stays bounded by the page size rather
// than by the period's volume. Callers assemble the final file by prepending the shared
// header. A search failure is yielded as the last item.
export async function* generateConsumptionExportBucketCsv(
  auth: Authenticator,
  {
    period,
    filter,
  }: {
    period: ConsumptionPeriod;
    filter?: ConsumptionScopeFilter;
  }
): AsyncGenerator<Result<string, ElasticsearchError>> {
  const query = buildConsumptionScopeQuery({
    auth,
    startDate: period.startDate,
    endDate: period.endDate,
    filter,
  });

  const labelCache = new DimensionLabelCache();
  let searchAfter: estypes.SortResults | undefined;
  let hitCount: number;

  do {
    const result =
      await searchConsumptionAnalytics<AgentMessageConsumptionAnalyticsData>(
        query,
        {
          size: EXPORT_PAGE_SIZE,
          sort: ES_SORT,
          search_after: searchAfter,
        }
      );

    if (result.isErr()) {
      yield result;
      return;
    }

    const { hits } = result.value.hits;
    const docs = removeNulls(hits.map((hit) => hit._source));
    if (docs.length > 0) {
      const rows = await buildConsumptionLineExportRows(auth, docs, {
        labelCache,
      });
      yield new Ok(
        rowsToCsv(CONSUMPTION_LINE_EXPORT_HEADERS, rows, {
          includeHeader: false,
        })
      );
    }

    hitCount = hits.length;
    searchAfter = hits[hits.length - 1]?.sort;
  } while (hitCount === EXPORT_PAGE_SIZE);
}

export function buildConsumptionLineExportCsvHeader(): string {
  return rowsToCsv(CONSUMPTION_LINE_EXPORT_HEADERS, []);
}

export function rowsToNdjson(rows: ConsumptionLineExportRow[]): string {
  return (
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length > 0 ? "\n" : "")
  );
}

/**
 * Streams consumption export data page by page. The first ES page is fetched
 * eagerly: if it fails, an Err is returned so the caller can respond with a
 * proper API error. Once streaming has started (Ok), mid-stream failures are
 * appended as a raw error line (intentionally not valid CSV/NDJSON so parsers
 * break loudly) and the stream is closed.
 */
export async function streamConsumptionExport(
  auth: Authenticator,
  opts: {
    period: ConsumptionPeriod;
    filter?: ConsumptionScopeFilter;
    format: "csv" | "ndjson";
    signal?: AbortSignal;
    visibleGroupIds?: ReadonlySet<string>;
  }
): Promise<Result<ReadableStream<Uint8Array>, ElasticsearchError>> {
  const encoder = new TextEncoder();
  const { period, filter, format, signal, visibleGroupIds } = opts;

  const query = buildConsumptionScopeQuery({
    auth,
    startDate: period.startDate,
    endDate: period.endDate,
    filter,
  });

  // Fetch the first page eagerly so failures surface as a Result before
  // the caller commits to a streaming 200 response.
  const firstResult =
    await searchConsumptionAnalytics<AgentMessageConsumptionAnalyticsData>(
      query,
      { size: EXPORT_PAGE_SIZE, sort: ES_SORT }
    );

  if (firstResult.isErr()) {
    return new Err(firstResult.error);
  }

  const firstPageHits = firstResult.value.hits.hits;

  async function* pages(): AsyncGenerator<Uint8Array> {
    // Yield the first (already-fetched) page, then continue paginating.
    // Labels resolved on earlier pages are cached and reused.
    const labelCache = new DimensionLabelCache();
    let currentHits = firstPageHits;
    let isFirst = true;

    while (true) {
      const docs: AgentMessageConsumptionAnalyticsData[] = [];
      for (const hit of currentHits) {
        if (hit._source) {
          docs.push(hit._source);
        }
      }

      const rows = await buildConsumptionLineExportRows(auth, docs, {
        labelCache,
        visibleGroupIds,
      });

      const chunk =
        format === "csv"
          ? rowsToCsv(CONSUMPTION_LINE_EXPORT_HEADERS, rows, {
              includeHeader: isFirst,
            })
          : rowsToNdjson(rows);

      isFirst = false;
      yield encoder.encode(chunk);

      if (currentHits.length < EXPORT_PAGE_SIZE) {
        break;
      }

      if (signal?.aborted) {
        yield encoder.encode("ERROR: Export timed out.");
        return;
      }

      const searchAfter = currentHits[currentHits.length - 1]?.sort;
      const result =
        await searchConsumptionAnalytics<AgentMessageConsumptionAnalyticsData>(
          query,
          {
            size: EXPORT_PAGE_SIZE,
            sort: ES_SORT,
            search_after: searchAfter,
          }
        );

      if (result.isErr()) {
        logger.error(
          {
            workspaceId: auth.getNonNullableWorkspace().sId,
            startDate: period.startDate,
            endDate: period.endDate,
            filter,
            error: result.error.message,
          },
          "[Consumption Export] Failed to stream consumption lines"
        );
        yield encoder.encode("ERROR: Internal server error.");
        return;
      }

      currentHits = result.value.hits.hits;
    }
  }

  const stream = asyncGeneratorToReadableStream(pages(), {
    onError: (err) =>
      logger.error(
        { workspaceId: auth.getNonNullableWorkspace().sId, err },
        "[Consumption Export] Unexpected stream error"
      ),
  });

  return new Ok(stream);
}
