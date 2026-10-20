import type { ServerSideMCPServerConfigurationType } from "@app/lib/actions/mcp";
import { getMCPServerRequirements } from "@app/lib/actions/mcp_internal_actions/input_configuration";
import {
  buildCompanyDataConfiguration,
  buildCompanyDataWarehousesConfiguration,
} from "@app/lib/api/assistant/global_agents/configurations/dust/shared";
import { getDataSourcesAndWorkspaceIdForGlobalAgents } from "@app/lib/api/assistant/global_agents/tools";
import type { PrefetchedDataSourcesType } from "@app/lib/api/assistant/global_agents/tools";
import type { MCPServerViewType } from "@app/lib/api/mcp";
import type { Authenticator } from "@app/lib/auth";
import { generateRandomModelSId } from "@app/lib/resources/string_ids_server";

function viewRef(view: MCPServerViewType): {
  sId: string;
  internalMCPServerId: string | null;
} {
  return {
    sId: view.sId,
    // Internal server sId is the internalMCPServerId used on agent actions.
    internalMCPServerId:
      view.serverType === "internal" ? view.server.sId : null,
  };
}

function buildCompanyDefaultForView(
  preFetched: PrefetchedDataSourcesType,
  view: MCPServerViewType
): ServerSideMCPServerConfigurationType | null {
  switch (view.server.name) {
    case "data_warehouses":
      return buildCompanyDataWarehousesConfiguration(preFetched, viewRef(view));
    case "data_sources_file_system":
      return buildCompanyDataConfiguration(preFetched, viewRef(view));
    default:
      return null;
  }
}

/**
 * Empty / view-default server configuration used when a function invocation has no agent and
 * no company default applies (same shape as JIT common utilities).
 */
export function emptySandboxFunctionServerConfiguration(
  view: MCPServerViewType
): ServerSideMCPServerConfigurationType {
  return {
    id: -1,
    sId: generateRandomModelSId(),
    type: "mcp_server_configuration",
    name: view.name ?? view.server.name,
    description: view.description ?? view.server.description,
    dataSources: null,
    tables: null,
    childAgentId: null,
    timeFrame: null,
    jsonSchema: null,
    additionalConfiguration: {},
    mcpServerViewId: view.sId,
    dustAppConfiguration: null,
    secretName: null,
    dustProject: null,
    internalMCPServerId:
      view.serverType === "internal" ? view.server.sId : null,
  };
}

/**
 * True when a function-token listing should include this view: either the server needs no
 * configuration, or Dust company defaults can supply the required data sources / warehouses.
 * Soft mayRequire* fields stay model-fillable. Call still allows tools that fail this check
 * when the caller supplies configuration URIs in rawInputs (backward compatible).
 */
export function canConfigureSandboxFunctionView(
  view: MCPServerViewType,
  companyConfig: ServerSideMCPServerConfigurationType | null
): boolean {
  const requirements = getMCPServerRequirements(view);
  if (requirements.noRequirement) {
    return true;
  }

  if (
    requirements.requiresChildAgentConfiguration ||
    requirements.requiresDustAppConfiguration ||
    requirements.requiresDustProjectConfiguration ||
    requirements.requiresTableConfiguration ||
    requirements.developerSecretSelection ||
    requirements.requiredStrings.some((c) => c.default === null) ||
    requirements.requiredNumbers.some((c) => c.default === null) ||
    requirements.requiredBooleans.some((c) => c.default === null) ||
    Object.values(requirements.requiredEnums).some((c) => c.default === null) ||
    Object.values(requirements.requiredLists).some((c) => c.default === null)
  ) {
    return false;
  }

  if (
    requirements.requiresDataWarehouseConfiguration ||
    requirements.requiresDataSourceConfiguration
  ) {
    return (companyConfig?.dataSources?.length ?? 0) > 0;
  }

  // Only soft mayRequire* (time frame, JSON schema) remain — the model can fill those.
  return true;
}

/**
 * Prefetch company data sources once, then map each listed view to a company-default
 * MCP server configuration when Dust would attach one (warehouses / company data).
 */
export async function loadCompanyDefaultConfigurationsByViewId(
  auth: Authenticator,
  views: MCPServerViewType[]
): Promise<Map<string, ServerSideMCPServerConfigurationType>> {
  const needsCompanyData = views.some(
    (view) =>
      view.server.name === "data_warehouses" ||
      view.server.name === "data_sources_file_system"
  );
  if (!needsCompanyData) {
    return new Map();
  }

  const preFetched = await getDataSourcesAndWorkspaceIdForGlobalAgents(auth);
  const byViewId = new Map<string, ServerSideMCPServerConfigurationType>();
  for (const view of views) {
    const config = buildCompanyDefaultForView(preFetched, view);
    if (config) {
      byViewId.set(view.sId, config);
    }
  }
  return byViewId;
}

/**
 * Drop views that require agent-side configuration the function token cannot satisfy, even
 * with Dust company defaults.
 */
export async function filterSandboxFunctionServerViews(
  auth: Authenticator,
  views: MCPServerViewType[]
): Promise<MCPServerViewType[]> {
  const companyConfigs = await loadCompanyDefaultConfigurationsByViewId(
    auth,
    views
  );
  return views.filter((view) =>
    canConfigureSandboxFunctionView(view, companyConfigs.get(view.sId) ?? null)
  );
}

/**
 * Server configuration for a function-token tool call: company defaults when available,
 * otherwise the empty view-default shape.
 */
export async function resolveSandboxFunctionServerConfiguration(
  auth: Authenticator,
  view: MCPServerViewType
): Promise<{
  companyConfig: ServerSideMCPServerConfigurationType | null;
  serverConfiguration: ServerSideMCPServerConfigurationType;
}> {
  const companyConfigs = await loadCompanyDefaultConfigurationsByViewId(auth, [
    view,
  ]);
  const companyConfig = companyConfigs.get(view.sId) ?? null;
  return {
    companyConfig,
    serverConfiguration:
      companyConfig ?? emptySandboxFunctionServerConfiguration(view),
  };
}
