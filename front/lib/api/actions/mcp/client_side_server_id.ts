import { slugify } from "@app/types/shared/utils/string_utils";

/**
 * Base id of the client-side MCP servers registered under `serverName`, as stored on their tool
 * configurations (the per-registration suffix is added at registration).
 */
export function getMCPServerIdFromServerName({
  serverName,
}: {
  serverName: string;
}): string {
  return `mcp-client-side:${slugify(serverName)}`;
}
