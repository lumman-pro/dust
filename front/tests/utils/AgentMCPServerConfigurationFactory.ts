import { autoInternalMCPServerNameToSId } from "@app/lib/actions/mcp_helper";
import type { Authenticator } from "@app/lib/auth";
import { AgentDataSourceConfigurationModel } from "@app/lib/models/agent/actions/data_sources";
import { AgentMCPServerConfigurationModel } from "@app/lib/models/agent/actions/mcp";
import type { DataSourceViewResource } from "@app/lib/resources/data_source_view_resource";
import type { MCPServerViewResource } from "@app/lib/resources/mcp_server_view_resource";
import type { SpaceResource } from "@app/lib/resources/space_resource";
import { generateRandomModelSId } from "@app/lib/resources/string_ids_server";
import { AgentConfigurationFactory } from "@app/tests/utils/AgentConfigurationFactory";
import { MCPServerViewFactory } from "@app/tests/utils/MCPServerViewFactory";
import type { AgentConfigurationType } from "@app/types/assistant/agent";

export class AgentMCPServerConfigurationFactory {
  static async create(
    auth: Authenticator,
    space: SpaceResource,
    options?: {
      agent?: AgentConfigurationType;
      mcpServerView?: MCPServerViewResource;
      /**
       * When set, links each data source view to the created MCP server
       * configuration (agent tooling dataSources / warehouses).
       */
      dataSourceViews?: DataSourceViewResource[];
    }
  ): Promise<AgentMCPServerConfigurationModel> {
    const owner = auth.getNonNullableWorkspace();

    const agent =
      options?.agent ?? (await AgentConfigurationFactory.createTestAgent(auth));

    const mcpServerView =
      options?.mcpServerView ??
      (await MCPServerViewFactory.create(
        owner,
        autoInternalMCPServerNameToSId({
          name: "search",
          workspaceId: owner.id,
        }),
        space
      ));

    const config = await AgentMCPServerConfigurationModel.create({
      sId: generateRandomModelSId(),
      agentConfigurationId: agent.id,
      workspaceId: owner.id,
      mcpServerViewId: mcpServerView.id,
      internalMCPServerId: mcpServerView.internalMCPServerId,
      additionalConfiguration: {},
      timeFrame: null,
      jsonSchema: null,
      name: null,
      singleToolDescriptionOverride: null,
      appId: null,
    });

    for (const dataSourceView of options?.dataSourceViews ?? []) {
      await AgentDataSourceConfigurationModel.create({
        workspaceId: owner.id,
        dataSourceId: dataSourceView.dataSource.id,
        dataSourceViewId: dataSourceView.id,
        mcpServerConfigurationId: config.id,
        tagsMode: null,
        tagsIn: null,
        tagsNotIn: null,
        parentsIn: null,
      });
    }

    return config;
  }
}
