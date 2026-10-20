import { hideInternalConfiguration } from "@app/lib/actions/mcp_internal_actions/input_configuration";
import { isServerSideMCPServerConfiguration } from "@app/lib/actions/types/guards";
import { FILES_SERVER_NAME } from "@app/lib/api/actions/servers/files/metadata";
import { SANDBOX_TOOL_NAME } from "@app/lib/api/actions/servers/sandbox/metadata";
import { getPinnedAgentToolingForAgentMessage } from "@app/lib/api/assistant/configuration/run_configuration";
import { getJITServers } from "@app/lib/api/assistant/jit_actions";
import { resolveSkillMCPServers } from "@app/lib/api/assistant/skill_actions";
import type { MCPServerViewType } from "@app/lib/api/mcp";
import {
  isSandboxExecTokenPayload,
  isSandboxFunctionInvocationTokenPayload,
} from "@app/lib/api/sandbox/access_tokens";
import { filterSandboxFunctionServerViews } from "@app/lib/api/sandbox/company_default_configurations";
import { selectServerViewsByReference } from "@app/lib/api/sandbox/server_view_reference";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { MCPServerViewResource } from "@app/lib/resources/mcp_server_view_resource";
import { sandboxApp } from "@front-api/middlewares/ctx";
import { sandboxAuth } from "@front-api/middlewares/sandbox_auth";
import type { HandlerResult } from "@front-api/middlewares/utils";
import { apiError } from "@front-api/middlewares/utils";
import aId from "./[aId]";
import call from "./call";

interface GetSandboxToolsResponseType {
  serverViews: MCPServerViewType[];
}

// Mounted at /api/v1/w/:wId/sandbox/actions.
const app = sandboxApp();

// The dsbx CLI hits these same URLs from both conversation sandboxes (exec tokens) and
// sandbox function invocations; handlers branch on the claims kind.
app.use(
  "*",
  sandboxAuth({ allowedTokenKinds: ["action", "function_invocation"] })
);

// Servers the sandbox must never see: `sandbox` is the server that runs the sandbox itself, and
// the file system the `files` server exposes is mounted in the sandbox under `/files`, so direct
// file operations always beat a round-trip through the tool.
const SANDBOX_HIDDEN_SERVER_NAMES: string[] = [
  SANDBOX_TOOL_NAME,
  FILES_SERVER_NAME,
];

// Tools an admin disabled on the server are refused by `/call`, so listing them only sends the
// agent into guaranteed failures.
function withoutDisabledTools(view: MCPServerViewType): MCPServerViewType {
  const disabledToolNames = new Set(
    (view.toolsMetadata ?? [])
      .filter((tool) => tool.enabled === false)
      .map((tool) => tool.toolName)
  );
  if (disabledToolNames.size === 0) {
    return view;
  }

  return {
    ...view,
    server: {
      ...view.server,
      tools: view.server.tools.filter(
        (tool) => !disabledToolNames.has(tool.name)
      ),
    },
  };
}

// Match the agent-loop path (`buildToolSpecification`): required TOOL_INPUT.* props are
// injected server-side, so exposing them in `dsbx tools` only makes agents invent URIs.
function withoutInternalConfiguration(
  view: MCPServerViewType
): MCPServerViewType {
  if (view.serverType !== "internal") {
    return view;
  }

  return {
    ...view,
    server: {
      ...view.server,
      tools: view.server.tools.map((tool) =>
        tool.inputSchema
          ? {
              ...tool,
              inputSchema: hideInternalConfiguration(tool.inputSchema),
            }
          : tool
      ),
    },
  };
}

// Response shaping shared by both token kinds: disabled tools removal, hide required
// configurable inputs, `?server=` reference resolution and `?light=true` inputSchema stripping.
function filterServerViews(
  views: MCPServerViewType[],
  { server, light }: { server?: string; light?: string }
): MCPServerViewType[] {
  let serverViews = views
    .filter((sv) => !SANDBOX_HIDDEN_SERVER_NAMES.includes(sv.server.name))
    .map(withoutDisabledTools)
    .map(withoutInternalConfiguration);

  if (server !== undefined) {
    serverViews = selectServerViewsByReference(serverViews, server);
  }

  // Strip tool inputSchemas in light mode.
  if (light === "true") {
    serverViews = serverViews.map((sv) => ({
      ...sv,
      server: {
        ...sv.server,
        tools: sv.server.tools.map(({ inputSchema, ...rest }) => rest),
      },
    }));
  }

  return serverViews;
}

/**
 * @ignoreswagger
 * internal endpoint
 */
app.get("/", async (ctx): HandlerResult<GetSandboxToolsResponseType> => {
  const auth = ctx.get("auth");
  const claims = ctx.get("sandboxClaims");

  // Sandbox function invocations have no agent configuration or conversation: they see the
  // servers of their pod space (+ global space). Servers that still need agent-side config after
  // Dust company defaults are omitted (same set `/call` can satisfy).
  if (isSandboxFunctionInvocationTokenPayload(claims)) {
    // Deliberately not the EnsuringAutoViews variant: token read paths must not write. Auto
    // views not yet materialized in the global space stay invisible until another surface
    // hydrates them.
    const views = await MCPServerViewResource.listBySpaceIds(
      auth,
      [claims.spaceId],
      {
        includeGlobalSpace: true,
        mode: "configuration",
      }
    );

    const serverViews = await filterSandboxFunctionServerViews(
      auth,
      views.map((view) => view.toJSON())
    );

    return ctx.json(
      { serverViews: filterServerViews(serverViews, ctx.req.query()) },
      200
    );
  }

  if (!isSandboxExecTokenPayload(claims)) {
    return apiError(ctx, {
      status_code: 403,
      api_error: {
        type: "invalid_request_error",
        message: "This sandbox token cannot access sandbox actions.",
      },
    });
  }
  const { aId: agentId, aV: agentVersion, cId, mId } = claims;

  const conversationResource = await ConversationResource.fetchById(auth, cId);
  if (!conversationResource) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "conversation_not_found",
        message: `Conversation ${cId} not found.`,
      },
    });
  }
  const conversation = conversationResource.toJSON();

  const agentMessageRes = await conversationResource.getMessageById(auth, mId);
  if (agentMessageRes.isErr()) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "message_not_found",
        message: `Agent message ${mId} not found.`,
      },
    });
  }

  // Fetch agent accessible servers.
  const agentConfig = await getPinnedAgentToolingForAgentMessage(auth, {
    agentVersion,
    conversation: conversationResource,
    agentMessage: agentMessageRes.value,
  });
  if (!agentConfig) {
    return apiError(ctx, {
      status_code: 404,
      api_error: {
        type: "agent_configuration_not_found",
        message: `Agent configuration ${agentId} not found.`,
      },
    });
  }

  const viewIds = new Set(
    agentConfig.actions
      .filter(isServerSideMCPServerConfiguration)
      .map((action) => action.mcpServerViewId)
  );

  // Fetch conversation-jitted servers.
  // No attachments: matches `createSandboxChildAction`, so the tools listed here are exactly
  // the ones `/call` can resolve. Deriving them would also mean recomputing the conversation's
  // attachment set on every poll.
  const jitServers = await getJITServers(auth, {
    agentConfiguration: agentConfig,
    conversation,
    attachments: [],
  });
  const { systemSkillServers, skillServers } = await resolveSkillMCPServers(
    auth,
    {
      agentConfiguration: agentConfig,
      conversation,
    }
  );
  for (const srv of jitServers) {
    viewIds.add(srv.mcpServerViewId);
  }
  for (const srv of [...systemSkillServers, ...skillServers]) {
    if (isServerSideMCPServerConfiguration(srv)) {
      viewIds.add(srv.mcpServerViewId);
    }
  }

  if (viewIds.size === 0) {
    return ctx.json({ serverViews: [] }, 200);
  }

  // Fetch the server views with their tools metadata.
  const views = await MCPServerViewResource.fetchByIds(auth, [...viewIds], {
    mode: "configuration",
  });

  return ctx.json(
    {
      serverViews: filterServerViews(
        views.map((view) => view.toJSON()),
        ctx.req.query()
      ),
    },
    200
  );
});

// `/call` (literal) must be registered before `/:aId` (param) so the param
// route does not swallow "call" as an action id.
app.route("/call", call);
app.route("/:aId", aId);

export default app;
