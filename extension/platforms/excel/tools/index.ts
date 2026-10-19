import {
  buildTools,
  type ClientToolHandlers,
} from "@app/lib/actions/mcp_internal_actions/tool_definition";

import {
  EXCEL_TOOLS_METADATA,
  READ_WORKBOOK_TOOL_NAME,
  WRITE_WORKBOOK_TOOL_NAME,
} from "@extension/platforms/excel/tools/metadata";
import { readWorkbookTool } from "@extension/platforms/excel/tools/readWorkbookTool";
import { writeWorkbookTool } from "@extension/platforms/excel/tools/writeWorkbookTool";
import { registerClientTools } from "@extension/shared/lib/mcp_tools";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Registers all Excel MCP tools with the server
 * @param server The MCP server to register tools with
 */
export function registerAllTools(server: McpServer): void {
  const handlers: ClientToolHandlers<typeof EXCEL_TOOLS_METADATA> = {
    [READ_WORKBOOK_TOOL_NAME]: (params) => readWorkbookTool(params),
    [WRITE_WORKBOOK_TOOL_NAME]: (params) => writeWorkbookTool(params),
  };

  const tools = buildTools(EXCEL_TOOLS_METADATA, handlers);

  registerClientTools(server, tools);
}
