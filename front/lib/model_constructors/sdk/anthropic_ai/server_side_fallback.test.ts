// Recorded-shape fixtures for Anthropic server-side refusal fallback
// (`fallbacks`, beta `server-side-fallback-2026-07-01`): a `fallback` content
// block marks each model switch and `usage.iterations` reports one entry per
// attempt, the serving one typed `fallback_message`.
import type {
  BetaContentBlock,
  BetaIterationsUsage,
  BetaMessage,
  BetaMessageDeltaUsage,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { OutputEventConverters } from "@app/lib/model_constructors/sdk/anthropic_ai/converters/output/utils";
import {
  accumulatedReasoningToReasoningEvent,
  accumulatedTextToTextEvent,
  accumulatedToolCallToToolCallEvent,
  inputJsonDeltaToToolCallDeltaEvent,
  invalidJsonToolCallToToolCallEvent,
  messageDeltaUsageToTokenUsageEvent,
  messageStartToResponseIdEvent,
  messageToEvents,
  rawOutputToEvents,
  reasoningDeltaToReasoningDeltaEvent,
  serverToolBlockToProviderPassthroughEvent,
  stopReasonToErrorEvent,
  streamErrorToErrorEvent,
  textDeltaToTextDeltaEvent,
  toolUseBlockStartToToolCallStartedEvent,
} from "@app/lib/model_constructors/sdk/anthropic_ai/converters/output/utils";
import type { EndpointMetadata } from "@app/lib/model_constructors/types/endpoint_metadata";
import type {
  ModelResponseEvent,
  TokenUsageEvent,
} from "@app/lib/model_constructors/types/output/events";
import { describe, expect, it } from "vitest";

const REQUESTED_MODEL = "claude-opus-5-5";
const FALLBACK_MODEL = "claude-opus-4-8";

const metadata: EndpointMetadata = {
  lab: "anthropic",
  host: "anthropic",
  region: "eu",
  model: REQUESTED_MODEL,
};

const converters: OutputEventConverters = {
  messageStartToResponseIdEvent,
  textDeltaToTextDeltaEvent,
  reasoningDeltaToReasoningDeltaEvent,
  accumulatedTextToTextEvent,
  accumulatedReasoningToReasoningEvent,
  toolUseBlockStartToToolCallStartedEvent,
  inputJsonDeltaToToolCallDeltaEvent,
  accumulatedToolCallToToolCallEvent,
  invalidJsonToolCallToToolCallEvent,
  serverToolBlockToProviderPassthroughEvent,
  messageDeltaUsageToTokenUsageEvent,
  stopReasonToErrorEvent,
  streamErrorToErrorEvent,
};

const FALLBACK_BLOCK: BetaContentBlock = {
  type: "fallback",
  from: { model: REQUESTED_MODEL },
  to: { model: FALLBACK_MODEL },
  trigger: { type: "refusal", category: "cyber" },
};

// Declined attempt on the requested model, then the fallback model serving.
const FALLBACK_ITERATIONS: BetaIterationsUsage = [
  {
    type: "message",
    model: REQUESTED_MODEL,
    input_tokens: 100,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_creation: null,
    output_tokens: 7,
  },
  {
    type: "fallback_message",
    model: FALLBACK_MODEL,
    input_tokens: 110,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 20,
    cache_creation: null,
    output_tokens: 30,
  },
];

const EXPECTED_USAGE_ITERATIONS = [
  {
    type: "message",
    model: REQUESTED_MODEL,
    cacheCreated: 0,
    cacheHit: 0,
    standardInput: 100,
    totalOutput: 7,
  },
  {
    type: "fallback_message",
    model: FALLBACK_MODEL,
    cacheCreated: 20,
    cacheHit: 0,
    standardInput: 110,
    totalOutput: 30,
  },
];

function deltaUsage(
  iterations: BetaIterationsUsage | null
): BetaMessageDeltaUsage {
  return {
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 0,
    fallback_credit: null,
    input_tokens: 110,
    iterations,
    output_tokens: 30,
    output_tokens_details: null,
    server_tool_use: null,
  };
}

function message({
  model,
  content,
  stopReason,
  iterations,
}: {
  model: string;
  content: BetaContentBlock[];
  stopReason: BetaStopReason | null;
  iterations: BetaIterationsUsage | null;
}): BetaMessage {
  return {
    id: "msg_1",
    container: null,
    content,
    context_management: null,
    diagnostics: null,
    model,
    role: "assistant",
    stop_details: null,
    stop_reason: stopReason,
    stop_sequence: null,
    type: "message",
    usage: {
      ...deltaUsage(iterations),
      input_tokens: 110,
      cache_creation: null,
      inference_geo: null,
      service_tier: "standard",
      speed: null,
    },
  };
}

function textBlockEvents(
  index: number,
  text: string
): BetaRawMessageStreamEvent[] {
  return [
    {
      type: "content_block_start",
      index,
      content_block: { type: "text", text: "", citations: null },
    },
    {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
    { type: "content_block_stop", index },
  ];
}

// Mid-stream fallback: the requested model streams a partial, declines, and the
// fallback model continues on the same stream after a `fallback` block. Pass
// `withFallback: false` for the same stream without any model switch.
function streamEvents({
  withFallback,
  stopReason,
}: {
  withFallback: boolean;
  stopReason: BetaStopReason;
}): BetaRawMessageStreamEvent[] {
  const fallbackEvents: BetaRawMessageStreamEvent[] = withFallback
    ? [
        {
          type: "content_block_start",
          index: 1,
          content_block: FALLBACK_BLOCK,
        },
        { type: "content_block_stop", index: 1 },
      ]
    : [];
  return [
    {
      type: "message_start",
      message: message({
        model: REQUESTED_MODEL,
        content: [],
        stopReason: null,
        iterations: null,
      }),
    },
    ...textBlockEvents(0, "Partial "),
    ...fallbackEvents,
    ...textBlockEvents(withFallback ? 2 : 1, "answer."),
    {
      type: "message_delta",
      delta: {
        container: null,
        stop_details: null,
        stop_reason: stopReason,
        stop_sequence: null,
      },
      usage: deltaUsage(withFallback ? FALLBACK_ITERATIONS : null),
      context_management: null,
    },
    { type: "message_stop" },
  ];
}

async function collect(
  events: BetaRawMessageStreamEvent[]
): Promise<ModelResponseEvent[]> {
  async function* stream(): AsyncGenerator<BetaRawMessageStreamEvent> {
    yield* events;
  }
  const out: ModelResponseEvent[] = [];
  for await (const event of rawOutputToEvents(stream(), metadata, converters)) {
    out.push(event);
  }
  return out;
}

function tokenUsageOf(
  events: readonly ModelResponseEvent[]
): TokenUsageEvent["content"] | undefined {
  return events.find(
    (event): event is TokenUsageEvent => event.type === "token_usage"
  )?.content;
}

function withoutTokenUsage(
  events: readonly ModelResponseEvent[]
): ModelResponseEvent[] {
  return events.filter((event) => event.type !== "token_usage");
}

describe("Anthropic server-side fallback (streaming)", () => {
  it("leaves usage without fallback fields when no fallback ran", async () => {
    const events = await collect(
      streamEvents({ withFallback: false, stopReason: "end_turn" })
    );

    expect(events.map((e) => e.type)).toEqual([
      "response_id",
      "text_delta",
      "text",
      "text_delta",
      "text",
      "token_usage",
      "success",
    ]);
    expect(tokenUsageOf(events)).toEqual({
      cacheCreated: 20,
      longCacheCreated: 0,
      shortCacheCreated: 0,
      cacheHit: 0,
      standardInput: 110,
      totalOutput: 30,
    });
  });

  it("ignores the fallback block and captures the served model and iterations", async () => {
    const withoutFallback = await collect(
      streamEvents({ withFallback: false, stopReason: "end_turn" })
    );
    const withFallback = await collect(
      streamEvents({ withFallback: true, stopReason: "end_turn" })
    );

    // The fallback block surfaces nowhere: every non-usage event is identical.
    expect(withoutTokenUsage(withFallback)).toEqual(
      withoutTokenUsage(withoutFallback)
    );
    expect(tokenUsageOf(withFallback)).toEqual({
      ...tokenUsageOf(withoutFallback),
      servedModel: FALLBACK_MODEL,
      usageIterations: EXPECTED_USAGE_ITERATIONS,
    });
  });

  it("still ends on the refusal when the fallback model also refused", async () => {
    const events = await collect(
      streamEvents({ withFallback: true, stopReason: "refusal" })
    );

    expect(events.slice(-2).map((e) => e.type)).toEqual([
      "token_usage",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({ content: { type: "refusal_error" } });
    expect(events.some((e) => e.type === "success")).toBe(false);
    expect(tokenUsageOf(events)).toMatchObject({
      servedModel: FALLBACK_MODEL,
      usageIterations: EXPECTED_USAGE_ITERATIONS,
    });
  });

  it("does not report a served model for iterations without a fallback_message entry", async () => {
    // Server tool loops already report `message` iterations without any switch.
    const usage = deltaUsage([FALLBACK_ITERATIONS[0]]);
    const event = messageDeltaUsageToTokenUsageEvent(metadata, usage, null);

    expect(event.content).not.toHaveProperty("servedModel");
    expect(event.content).not.toHaveProperty("usageIterations");
  });
});

describe("Anthropic server-side fallback (non-streaming)", () => {
  const answer: BetaContentBlock = {
    type: "text",
    text: "Answer.",
    citations: null,
  };

  it("leaves usage without fallback fields when no fallback ran", () => {
    const events = messageToEvents(
      message({
        model: REQUESTED_MODEL,
        content: [answer],
        stopReason: "end_turn",
        iterations: null,
      }),
      metadata,
      converters
    );

    expect(events.map((e) => e.type)).toEqual([
      "response_id",
      "text",
      "token_usage",
      "success",
    ]);
    expect(tokenUsageOf(events)).not.toHaveProperty("servedModel");
    expect(tokenUsageOf(events)).not.toHaveProperty("usageIterations");
  });

  it("ignores the fallback block and captures the served model and iterations", () => {
    const withoutFallback = messageToEvents(
      message({
        model: REQUESTED_MODEL,
        content: [answer],
        stopReason: "end_turn",
        iterations: null,
      }),
      metadata,
      converters
    );
    const withFallback = messageToEvents(
      message({
        model: FALLBACK_MODEL,
        content: [FALLBACK_BLOCK, answer],
        stopReason: "end_turn",
        iterations: FALLBACK_ITERATIONS,
      }),
      metadata,
      converters
    );

    expect(withoutTokenUsage(withFallback)).toEqual(
      withoutTokenUsage(withoutFallback)
    );
    expect(tokenUsageOf(withFallback)).toEqual({
      ...tokenUsageOf(withoutFallback),
      servedModel: FALLBACK_MODEL,
      usageIterations: EXPECTED_USAGE_ITERATIONS,
    });
  });

  it("still surfaces the refusal when the fallback model also refused", () => {
    const events = messageToEvents(
      message({
        model: FALLBACK_MODEL,
        content: [FALLBACK_BLOCK],
        stopReason: "refusal",
        iterations: FALLBACK_ITERATIONS,
      }),
      metadata,
      converters
    );

    expect(events.map((e) => e.type)).toEqual([
      "response_id",
      "error",
      "token_usage",
      "success",
    ]);
    expect(events.find((e) => e.type === "error")).toMatchObject({
      content: { type: "refusal_error" },
    });
    expect(tokenUsageOf(events)).toMatchObject({
      servedModel: FALLBACK_MODEL,
      usageIterations: EXPECTED_USAGE_ITERATIONS,
    });
  });
});
