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

const optionalDustPodTool = {
  name: "add_content_node",
  description: "Add",
  inputSchema: {
    type: "object" as const,
    properties: {
      title: { type: "string" as const },
      dustPod:
        ConfigurableToolInputJSONSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DUST_POD
        ],
    },
    required: ["title"],
  },
};

const requiredDustPodTool = {
  name: "needs_pod",
  description: "Needs pod",
  inputSchema: {
    type: "object" as const,
    properties: {
      dustPod:
        ConfigurableToolInputJSONSchemas[
          INTERNAL_MIME_TYPES.TOOL_INPUT.DUST_POD
        ],
    },
    required: ["dustPod"],
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

  it("keeps servers with optional Dust inputs (e.g. pod_manager dustPod)", () => {
    const view = MCPServerViewTypeFactory.build({
      serverType: "internal",
      name: null,
      server: {
        sId: "internal_test",
        name: "pod_manager",
        availability: "auto",
        allowMultipleInstances: false,
        icon: "ActionTableIcon",
        tools: [optionalDustPodTool],
      },
    });
    expect(canConfigureSandboxFunctionView(view, null)).toBe(true);
  });

  it("rejects servers with required Dust inputs that company defaults cannot fill", () => {
    const view = MCPServerViewTypeFactory.build({
      serverType: "internal",
      name: null,
      server: {
        sId: "internal_test",
        name: "needs_required_pod",
        availability: "auto",
        allowMultipleInstances: false,
        icon: "ActionTableIcon",
        tools: [requiredDustPodTool],
      },
    });
    expect(canConfigureSandboxFunctionView(view, null)).toBe(false);
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
