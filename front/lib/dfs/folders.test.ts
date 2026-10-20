import { isPodNameTooLong, podFolderName } from "@app/lib/dfs/folders";
import { describe, expect, it } from "vitest";

function nameOf(name: string) {
  const res = podFolderName(name);
  return res.isOk() ? res.value : res.error.code;
}

describe("podFolderName", () => {
  it("keeps a name without characters to encode", () => {
    expect(nameOf("Équipe Paris (draft)")).toBe("Équipe Paris (draft)");
  });

  it("percent-encodes only %, /, control characters and a leading dot", () => {
    expect(nameOf(".a/b%c\nd.e")).toBe("%2Ea%2Fb%25c%0Ad.e");
  });

  it("gives different names to names that differ only by encoded characters", () => {
    expect(nameOf("a/b")).not.toBe(nameOf("a-b"));
    expect(nameOf("a%2Fb")).not.toBe(nameOf("a/b"));
  });

  it("refuses an empty name and a name longer than 255 bytes once encoded", () => {
    expect(nameOf("")).toBe("invalid_input");
    expect(nameOf("a".repeat(255))).toBe("a".repeat(255));
    expect(nameOf("/".repeat(86))).toBe("invalid_input");
  });
});

describe("isPodNameTooLong", () => {
  it("compares the encoded name with the 255-byte limit", () => {
    expect(isPodNameTooLong("a".repeat(255))).toBe(false);
    expect(isPodNameTooLong("/".repeat(85))).toBe(false);
    expect(isPodNameTooLong("/".repeat(86))).toBe(true);
  });
});
