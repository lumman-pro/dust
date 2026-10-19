import { podFolderName } from "@app/lib/dfs/folders";
import { describe, expect, it } from "vitest";

function nameOf(name: string) {
  return podFolderName({ sId: "pod_1", name });
}

describe("podFolderName", () => {
  it("keeps a valid name", () => {
    expect(nameOf("Q3 roadmap (draft)")).toBe("Q3 roadmap (draft)");
  });

  it("replaces slashes and control characters", () => {
    expect(nameOf("a/b\u0000c\nd")).toBe("a-b-c-d");
  });

  it("removes surrounding whitespace and leading dots", () => {
    expect(nameOf("  . .hidden  ")).toBe("hidden");
  });

  it("falls back to the pod sId when nothing is left", () => {
    expect(nameOf("..")).toBe("pod-pod_1");
    expect(nameOf("   ")).toBe("pod-pod_1");
  });

  it("cuts to 255 bytes without splitting a character", () => {
    const name = nameOf("é".repeat(200));

    expect(name).toBe("é".repeat(127));
    expect(Buffer.byteLength(name)).toBe(254);
  });
});
