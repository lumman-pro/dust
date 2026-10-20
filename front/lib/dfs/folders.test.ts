import { podFolderNames } from "@app/lib/dfs/folders";
import { describe, expect, it } from "vitest";

function namesOf(name: string) {
  return podFolderNames({ sId: "pod_1", name });
}

describe("podFolderNames", () => {
  it("keeps a name without characters to encode, then the unique name", () => {
    expect(namesOf("Équipe Paris (draft)")).toEqual([
      "Équipe Paris (draft)",
      "Équipe Paris (draft) (pod_1)",
    ]);
  });

  it("percent-encodes only %, /, control characters and a leading dot", () => {
    expect(namesOf(".a/b%c\nd.e")[0]).toBe("%2Ea%2Fb%25c%0Ad.e");
  });

  it("gives different names to names that differ only by encoded characters", () => {
    expect(namesOf("a/b")[0]).not.toBe(namesOf("a-b")[0]);
    expect(namesOf("a%2Fb")[0]).not.toBe(namesOf("a/b")[0]);
  });

  it("only gives the unique name to an empty pod name", () => {
    expect(namesOf("")).toEqual(["pod-pod_1"]);
  });

  it("only gives a unique name cut to 255 bytes to a name too long", () => {
    const names = namesOf("/".repeat(100));

    expect(names).toHaveLength(1);
    expect(names[0]).toBe(`${"%2F".repeat(82)} (pod_1)`);
    expect(Buffer.byteLength(names[0])).toBeLessThanOrEqual(255);
  });
});
