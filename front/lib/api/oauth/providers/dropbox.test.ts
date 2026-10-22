import { DropboxOAuthProvider } from "@app/lib/api/oauth/providers/dropbox";
import type { ExtraConfigType } from "@app/types/oauth/lib";
import { describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/config", () => ({
  default: {
    getAppUrl: () => "https://dust.tt",
    getOAuthDropboxClientId: () => "client-id",
  },
}));

describe("DropboxOAuthProvider.setupUri", () => {
  it("requests offline access so Dropbox returns a refresh token", () => {
    const provider = new DropboxOAuthProvider();
    const setupUri = provider.setupUri({
      connection: {
        connection_id: "connection-id",
        created: Date.now(),
        metadata: {},
        provider: "dropbox",
        status: "pending",
      },
      useCase: "personal_actions",
    });

    const url = new URL(setupUri);

    expect(url.origin + url.pathname).toBe(
      "https://www.dropbox.com/oauth2/authorize"
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("token_access_type")).toBe("offline");
    expect(url.searchParams.get("state")).toBe("connection-id");
    expect(url.searchParams.get("scope")?.split(" ")).toContain(
      "files.content.read"
    );
  });
});

describe("DropboxOAuthProvider.isExtraConfigValid", () => {
  it.each<{ extraConfig: ExtraConfigType; valid: boolean }>([
    { extraConfig: {}, valid: true },
    { extraConfig: { mcp_server_id: "server-id" }, valid: true },
    { extraConfig: { client_id: "client-id" }, valid: false },
  ])("$extraConfig -> $valid", ({ extraConfig, valid }) => {
    expect(
      new DropboxOAuthProvider().isExtraConfigValid(
        extraConfig,
        "platform_actions"
      )
    ).toBe(valid);
  });
});
