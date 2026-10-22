import type { TokenUsage } from "@app/lib/api/llm/types/events";
import { emitFallbackMetrics } from "@app/lib/api/llm/usage_metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStatsDIncrement } = vi.hoisted(() => ({
  mockStatsDIncrement: vi.fn(),
}));

vi.mock("@app/lib/utils/statsd", () => ({
  statsDMetrics: { increment: mockStatsDIncrement },
}));

const usage: TokenUsage = {
  inputTokens: 10,
  totalOutputTokens: 5,
  totalTokens: 15,
};

describe("emitFallbackMetrics", () => {
  beforeEach(() => {
    mockStatsDIncrement.mockReset();
  });

  it("emits nothing when the requested model answered", () => {
    emitFallbackMetrics(usage, ["model_id:claude-opus-5-5"]);

    expect(mockStatsDIncrement).not.toHaveBeenCalled();
  });

  it("counts a fallback with the served model tag", () => {
    emitFallbackMetrics({ ...usage, servedModel: "claude-sonnet-5-5" }, [
      "model_id:claude-opus-5-5",
    ]);

    expect(mockStatsDIncrement).toHaveBeenCalledExactlyOnceWith(
      "llm_fallback.count",
      1,
      ["model_id:claude-opus-5-5", "served_model_id:claude-sonnet-5-5"]
    );
  });
});
