import type { DefaultRemoteMCPServerConfig } from "@app/lib/actions/mcp_internal_actions/remote_servers";
import {
  DEFAULT_REMOTE_MCP_SERVERS,
  getDefaultRemoteMCPServerAuthorization,
} from "@app/lib/actions/mcp_internal_actions/remote_servers";
import { describe, expect, it } from "vitest";

function makeConfig(
  auth: Pick<
    DefaultRemoteMCPServerConfig,
    "authMethod" | "oauthProvider" | "scope"
  >
): DefaultRemoteMCPServerConfig {
  return {
    id: 99999,
    name: "Test",
    description: "",
    url: "https://mcp.example.com/mcp",
    icon: "ActionGlobeAltIcon",
    supportedOAuthUseCases: ["personal_actions"],
    ...auth,
  };
}

describe("getDefaultRemoteMCPServerAuthorization", () => {
  it("uses the declared provider for an oauth-static-dust-app preset", () => {
    expect(
      getDefaultRemoteMCPServerAuthorization(
        makeConfig({
          authMethod: "oauth-static-dust-app",
          oauthProvider: "notion",
        })
      )
    ).toEqual({
      provider: "notion",
      supported_use_cases: ["personal_actions"],
    });
  });

  it("returns null for an oauth-static-dust-app preset without a provider", () => {
    expect(
      getDefaultRemoteMCPServerAuthorization(
        makeConfig({ authMethod: "oauth-static-dust-app" })
      )
    ).toBeNull();
  });

  it("uses mcp with the preset scope for an oauth-dynamic preset", () => {
    expect(
      getDefaultRemoteMCPServerAuthorization(
        makeConfig({ authMethod: "oauth-dynamic", scope: "read" })
      )
    ).toEqual({
      provider: "mcp",
      supported_use_cases: ["personal_actions"],
      scope: "read",
    });
  });

  it("uses mcp_static for an oauth-static preset", () => {
    expect(
      getDefaultRemoteMCPServerAuthorization(
        makeConfig({ authMethod: "oauth-static" })
      )
    ).toEqual({
      provider: "mcp_static",
      supported_use_cases: ["personal_actions"],
    });
  });

  it.each(["bearer", null] as const)(
    "returns null for a %s preset",
    (authMethod) => {
      expect(
        getDefaultRemoteMCPServerAuthorization(makeConfig({ authMethod }))
      ).toBeNull();
    }
  );
});

describe("DEFAULT_REMOTE_MCP_SERVERS", () => {
  it("sets oauthProvider exactly on oauth-static-dust-app presets", () => {
    for (const config of DEFAULT_REMOTE_MCP_SERVERS) {
      expect({
        name: config.name,
        hasOAuthProvider: config.oauthProvider !== undefined,
      }).toEqual({
        name: config.name,
        hasOAuthProvider: config.authMethod === "oauth-static-dust-app",
      });
    }
  });

  it("has unique ids", () => {
    const ids = DEFAULT_REMOTE_MCP_SERVERS.map((config) => config.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
