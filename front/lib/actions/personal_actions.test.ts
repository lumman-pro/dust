import { getCredentialModeDescriptionNote } from "@app/lib/actions/personal_actions";
import { describe, expect, it } from "vitest";

describe("getCredentialModeDescriptionNote", () => {
  it("describes personal credentials", () => {
    expect(getCredentialModeDescriptionNote("personal_actions")).toBe(
      "Note: Uses each user's personal credentials."
    );
  });

  it("describes workspace shared credentials", () => {
    expect(getCredentialModeDescriptionNote("platform_actions")).toBe(
      "Note: Uses the workspace shared credentials."
    );
  });

  it("returns null when no OAuth use case is set", () => {
    expect(getCredentialModeDescriptionNote(null)).toBeNull();
  });
});
