import config from "@app/lib/api/config";
import type { BaseOAuthStrategyProvider } from "@app/lib/api/oauth/providers/base_oauth_stragegy_provider";
import {
  finalizeUriForProvider,
  getStringFromQuery,
} from "@app/lib/api/oauth/utils";
import type {
  ExtraConfigType,
  OAuthConnectionType,
  OAuthUseCase,
} from "@app/types/oauth/lib";
import type { ParsedUrlQuery } from "querystring";

// Scopes advertised by the Dropbox remote MCP server (https://mcp.dropbox.com/mcp). They must also be
// enabled on Dust's Dropbox app.
const DROPBOX_SCOPES = [
  "account_info.read",
  "files.metadata.read",
  "files.metadata.write",
  "files.content.read",
  "files.content.write",
  "sharing.read",
  "sharing.write",
  "file_requests.read",
  "file_requests.write",
];

export class DropboxOAuthProvider implements BaseOAuthStrategyProvider {
  /**
   * @cc [owner:LeandreLeBizec,label:product] dropbox-offline-access
   * The authorization URL MUST request `token_access_type=offline`. Without it Dropbox issues no
   * refresh token, and connections stop working once the short-lived access token expires.
   */
  setupUri({
    connection,
  }: {
    connection: OAuthConnectionType;
    useCase: OAuthUseCase;
  }) {
    return (
      `https://www.dropbox.com/oauth2/authorize?` +
      `client_id=${config.getOAuthDropboxClientId()}` +
      `&scope=${encodeURIComponent(DROPBOX_SCOPES.join(" "))}` +
      `&response_type=code` +
      `&token_access_type=offline` +
      `&state=${connection.connection_id}` +
      `&redirect_uri=${encodeURIComponent(finalizeUriForProvider({ provider: "dropbox", connection }))}`
    );
  }

  codeFromQuery(query: ParsedUrlQuery) {
    return getStringFromQuery(query, "code");
  }

  connectionIdFromQuery(query: ParsedUrlQuery) {
    return getStringFromQuery(query, "state");
  }

  isExtraConfigValid(extraConfig: ExtraConfigType, _useCase: OAuthUseCase) {
    return (
      Object.keys(extraConfig).length === 0 ||
      (Object.keys(extraConfig).length === 1 && "mcp_server_id" in extraConfig)
    );
  }
}
