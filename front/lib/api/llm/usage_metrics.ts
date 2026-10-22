/**
 * StatsD emission for per-call LLM token usage. Called from the base LLM class's stream and
 * batch pipelines, which both the new router and the legacy per-provider clients flow through,
 * so every model call is covered regardless of routing.
 *
 * The cache split (hit vs created vs uncached) is the ground truth for prompt-cache health: the
 * conversation pruning system's whole goal is keeping the hit share high, so these series are
 * what its checkpoint constants get tuned against.
 *
 * Zero values are skipped. They contribute nothing to the sum aggregations the dashboards use,
 * and they would distort per-kind averages and mint constant-zero series for cache kinds a
 * provider never reports.
 */
import type { TokenUsage } from "@app/lib/api/llm/types/events";
import { statsDMetrics } from "@app/lib/utils/statsd";

export function emitTokenUsageMetrics(usage: TokenUsage, tags: string[]): void {
  const statsD = statsDMetrics;

  const cacheHit = usage.cachedTokens ?? 0;
  // The flat total is only set when the provider reports no per-duration breakdown. Otherwise
  // the split lives in long/short.
  const cacheCreated =
    usage.cacheCreationTokens ??
    (usage.longCacheCreationTokens ?? 0) +
      (usage.shortCacheCreationTokens ?? 0);
  // Providers that support caching report uncached input directly. For the rest, inputTokens is
  // the whole prompt.
  const uncached =
    usage.uncachedInputTokens ??
    Math.max(0, usage.inputTokens - cacheHit - cacheCreated);

  const inputByKind: Array<[string, number]> = [
    ["cache_hit", cacheHit],
    ["cache_created", cacheCreated],
    ["uncached", uncached],
  ];
  for (const [kind, value] of inputByKind) {
    if (value > 0) {
      statsD.distribution("llm_usage.input_tokens", value, [
        ...tags,
        `kind:${kind}`,
      ]);
    }
  }
  if (usage.totalOutputTokens > 0) {
    statsD.distribution(
      "llm_usage.output_tokens",
      usage.totalOutputTokens,
      tags
    );
  }
}

/**
 * @cc [owner:fontanierh,label:logging] fallback-metric-only-on-served-model
 * Increments `llm_fallback.count` once per response that has `servedModel`, i.e. when another
 * model answered instead of the requested one. Does nothing when `servedModel` is absent. Tags
 * stay low cardinality: the caller's tags plus `served_model_id`, never workspace or user IDs.
 */
export function emitFallbackMetrics(usage: TokenUsage, tags: string[]): void {
  if (usage.servedModel === undefined) {
    return;
  }
  statsDMetrics.increment("llm_fallback.count", 1, [
    ...tags,
    `served_model_id:${usage.servedModel}`,
  ]);
}
