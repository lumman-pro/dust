import { codeFence } from "@app/lib/markdown/code_fence";
import { describe, expect, it } from "vitest";

describe("codeFence", () => {
  it.each([
    ["no run", "plain", "`", "```"],
    ["a shorter run", "a `b` c", "`", "```"],
    ["a fence-long run mid-line", "a ``` b", "`", "````"],
    ["the other character", "```", "~", "~~~"],
    ["a tilde run", "~~~~", "~", "~~~~~"],
  ] as const)("fences code with %s", (_, code, char, fence) => {
    expect(codeFence(code, char)).toBe(fence);
  });
});
