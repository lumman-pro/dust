import { ConfigurableToolInputJSONSchemas } from "@app/lib/actions/mcp_internal_actions/input_schemas";
import { canConfigureSandboxFunctionView } from "@app/lib/api/sandbox/company_default_configurations";
import { MCPServerViewTypeFactory } from "@app/tests/utils/MCPServerViewTypeFactory";
import { INTERNAL_MIME_TYPES } from "@dust-tt/client";
import { describe, expect, it } from "vitest";

const warehouseListTool = {
  name: "list",
  description: "List",
  inputSchema: {
    type: "object" as const,
    properties: {
      dataSources:
        ConfigurableToolInputJSONSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DATA_WAREHOUSE
        ],
    },
    required: ["dataSources"],
  },
};

const companyWarehouseConfig = {
  id: -1,
  sId: "cfg",
  type: "mcp_server_configuration" as const,
  name: "data_warehouses",
  description: "",
  mcpServerViewId: "msv_test",
  internalMCPServerId: "internal_test",
  dataSources: [
    {
      dataSourceViewId: "dsv_1",
      workspaceId: "w_1",
      filter: { parents: { in: [], not: [] }, tags: null },
    },
  ],
  tables: null,
  childAgentId: null,
  additionalConfiguration: {},
  timeFrame: null,
  dustAppConfiguration: null,
  jsonSchema: null,
  secretName: null,
  dustProject: null,
};

describe("canConfigureSandboxFunctionView", () => {
  it("keeps servers with no configuration requirements", () => {
    const view = MCPServerViewTypeFactory.build({
      serverType: "internal",
      name: null,
      server: {
        sId: "internal_test",
        name: "common_utilities",
        availability: "auto",
        allowMultipleInstances: false,
        icon: "ActionTableIcon",
        tools: [
          {
            name: "web_search",
            description: "Search",
            inputSchema: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
      },
    });
    expect(canConfigureSandboxFunctionView(view, null)).toBe(true);
  });

  it("keeps data_warehouses when company config supplies dataSources", () => {
    const view = MCPServerViewTypeFactory.build({
      serverType: "internal",
      name: null,
      server: {
        sId: "internal_test",
        name: "data_warehouses",
        availability: "auto",
        allowMultipleInstances: false,
        icon: "ActionTableIcon",
        tools: [warehouseListTool],
      },
    });
    expect(
      canConfigureSandboxFunctionView(view, {
        ...companyWarehouseConfig,
        mcpServerViewId: view.sId,
        internalMCPServerId: view.server.sId,
      })
    ).toBe(true);
  });

  it("rejects data_warehouses without company dataSources for listing", () => {
    const view = MCPServerViewTypeFactory.build({
      serverType: "internal",
      name: null,
      server: {
        sId: "internal_test",
        name: "data_warehouses",
        availability: "auto",
        allowMultipleInstances: false,
        icon: "ActionTableIcon",
        tools: [warehouseListTool],
      },
    });
    expect(canConfigureSandboxFunctionView(view, null)).toBe(false);
  });
});
