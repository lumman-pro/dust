import type { ServerSideMCPServerConfigurationType } from "@app/lib/actions/mcp";
import type {
  MCPServerViewsForGlobalAgentsMap,
  PrefetchedDataSourcesType,
} from "@app/lib/api/assistant/global_agents/tools";
import {
  isIncludedInDefaultCompanyData,
  isRemoteDatabase,
} from "@app/lib/data_sources";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";

/** Minimal view identity for company-default MCP configs (global agents or sandbox). */
export type CompanyDefaultMcpViewRef = {
  sId: string;
  internalMCPServerId: string | null;
};

export function buildCompanyDataConfiguration(
  preFetchedDataSources: PrefetchedDataSourcesType | null,
  dataSourcesFileSystemView: CompanyDefaultMcpViewRef | null
): ServerSideMCPServerConfigurationType | null {
  if (!preFetchedDataSources || !dataSourcesFileSystemView) {
    return null;
  }

  const dataSourceViews = preFetchedDataSources.dataSourceViews.filter(
    (dsView) =>
      dsView.isInGlobalSpace &&
      isIncludedInDefaultCompanyData(dsView.dataSource)
  );
  if (dataSourceViews.length === 0) {
    return null;
  }

  return {
    id: -1,
    sId: GLOBAL_AGENTS_SID.DEEP_DIVE + "-company-data-action",
    type: "mcp_server_configuration",
    name: "company_data",
    description: "The user's internal company data.",
    mcpServerViewId: dataSourcesFileSystemView.sId,
    internalMCPServerId: dataSourcesFileSystemView.internalMCPServerId,
    dataSources: dataSourceViews.map((dsView) => ({
      dataSourceViewId: dsView.sId,
      workspaceId: preFetchedDataSources.workspaceId,
      filter: {
        parents: {
          in: dsView.parentsIn ?? [],
          not: [],
        },
        tags: null,
      },
    })),
    tables: null,
    childAgentId: null,
    additionalConfiguration: {},
    timeFrame: null,
    dustAppConfiguration: null,
    jsonSchema: null,
    secretName: null,
    dustProject: null,
  };
}

export function buildCompanyDataWarehousesConfiguration(
  preFetchedDataSources: PrefetchedDataSourcesType | null,
  dataWarehousesView: CompanyDefaultMcpViewRef | null
): ServerSideMCPServerConfigurationType | null {
  if (!preFetchedDataSources || !dataWarehousesView) {
    return null;
  }

  const globalWarehouses = preFetchedDataSources.dataSourceViews.filter(
    (dsView) => dsView.isInGlobalSpace && isRemoteDatabase(dsView.dataSource)
  );

  if (globalWarehouses.length === 0) {
    return null;
  }

  return {
    id: -1,
    sId: GLOBAL_AGENTS_SID.DEEP_DIVE + "-data-warehouses-action",
    type: "mcp_server_configuration",
    name: "data_warehouses",
    description: "The user's data warehouses.",
    mcpServerViewId: dataWarehousesView.sId,
    internalMCPServerId: dataWarehousesView.internalMCPServerId,
    dataSources: globalWarehouses.map((dsView) => ({
      dataSourceViewId: dsView.sId,
      workspaceId: preFetchedDataSources.workspaceId,
      filter: {
        parents: { in: dsView.parentsIn ?? [], not: [] },
        tags: null,
      },
    })),
    tables: null,
    childAgentId: null,
    additionalConfiguration: {},
    timeFrame: null,
    dustAppConfiguration: null,
    jsonSchema: null,
    secretName: null,
    dustProject: null,
  };
}

export function getCompanyDataAction(
  preFetchedDataSources: PrefetchedDataSourcesType | null,
  mcpServerViews: MCPServerViewsForGlobalAgentsMap
): ServerSideMCPServerConfigurationType | null {
  return buildCompanyDataConfiguration(
    preFetchedDataSources,
    mcpServerViews.data_sources_file_system
  );
}

export function getCompanyDataWarehousesAction(
  preFetchedDataSources: PrefetchedDataSourcesType | null,
  mcpServerViews: MCPServerViewsForGlobalAgentsMap
): ServerSideMCPServerConfigurationType | null {
  return buildCompanyDataWarehousesConfiguration(
    preFetchedDataSources,
    mcpServerViews.data_warehouses
  );
}
