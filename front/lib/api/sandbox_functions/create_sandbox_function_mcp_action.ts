import type {
  ServerSideMCPServerConfigurationType,
  ServerSideMCPToolConfigurationType,
} from "@app/lib/actions/mcp";
import { MCP_TOOL_CONFIGURATION_FIELDS_TO_OMIT } from "@app/lib/actions/mcp";
import { buildToolConfigurationsFromRawTools } from "@app/lib/actions/mcp_actions";
import { getAugmentedInputs } from "@app/lib/actions/mcp_execution";
import type { SandboxFunctionMCPApproveExecutionEvent } from "@app/lib/actions/mcp_internal_actions/events";
import { validateToolInputs } from "@app/lib/actions/mcp_utils";
import { makeMCPApproveExecutionEventBase } from "@app/lib/actions/tool_approval_events";
import { getExecutionStatusFromConfig } from "@app/lib/actions/tool_status";
import {
  buildAuditLogTarget,
  emitAuditLogEvent,
  getAuditLogContext,
} from "@app/lib/api/audit/workos_audit";
import { resolveSandboxFunctionServerConfiguration } from "@app/lib/api/sandbox/company_default_configurations";
import { buildSandboxFunctionAuditMetadata } from "@app/lib/api/sandbox_functions/audit";
import { publishSandboxFunctionBlockingEvent } from "@app/lib/api/sandbox_functions/publish_blocking_event";
import type { SandboxFunctionMcpActionServerTimingsMs } from "@app/lib/api/sandbox_functions/sandbox_function_mcp_action_server_timings";
import { roundMs } from "@app/lib/api/sandbox_functions/sandbox_function_mcp_action_server_timings";
import type { Authenticator } from "@app/lib/auth";
import { MCPServerViewResource } from "@app/lib/resources/mcp_server_view_resource";
import { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import { SandboxFunctionResource } from "@app/lib/resources/sandbox_function_resource";
import logger from "@app/logger/logger";
import { launchSandboxFunctionToolWorkflow } from "@app/temporal/sandbox_functions/client";
import type { Result } from "@app/types/shared/result";
import { Err, Ok } from "@app/types/shared/result";
import { assertNever } from "@app/types/shared/utils/assert_never";
import omit from "lodash/omit";

class SandboxFunctionMCPActionError extends Error {
  constructor(
    readonly type:
      | "server_view_not_found"
      | "tool_not_available"
      | "invalid_inputs"
      | "invocation_not_found",
    message: string
  ) {
    super(message);
  }
}

// Resolves a tool for execution from a sandbox function invocation. The tool must exist and be
// enabled. `companyConfig` is set when Dust company defaults apply (warehouses / company data);
// callers inject those into args and otherwise leave caller-supplied rawInputs alone so explicit
// dataSources URIs keep working without a company default.
async function resolveSandboxFunctionTool(
  auth: Authenticator,
  view: MCPServerViewResource<"configuration">,
  toolName: string
): Promise<
  Result<
    {
      toolConfiguration: ServerSideMCPToolConfigurationType;
      companyConfig: ServerSideMCPServerConfigurationType | null;
    },
    SandboxFunctionMCPActionError
  >
> {
  const viewJSON = view.toJSON();
  const tool = viewJSON.server.tools.find((t) => t.name === toolName);
  if (!tool) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "tool_not_available",
        `Tool ${toolName} not found on server ${viewJSON.server.name}.`
      )
    );
  }

  // No agent on the token: Dust company defaults (warehouses / company data) when available,
  // otherwise the empty view-default shape (same as JIT common utilities).
  const { companyConfig, serverConfiguration } =
    await resolveSandboxFunctionServerConfiguration(auth, viewJSON);

  const toolConfigurationsRes = await buildToolConfigurationsFromRawTools(
    auth,
    view.mcpServerId,
    {
      ...serverConfiguration,
      // Prefer the called view's display name over the company-default action name.
      name: viewJSON.name ?? viewJSON.server.name,
      description: viewJSON.description ?? viewJSON.server.description,
      mcpServerViewId: viewJSON.sId,
      // Null for remote servers, matching the agent path (see `configuration/actions.ts`).
      internalMCPServerId: view.internalMCPServerId,
    },
    // Pass the full tool (including inputSchema) so getAugmentedInputs can inject
    // company-default TOOL_INPUT.* fields.
    [tool],
    view.remoteMCPServerUrl
  );
  if (toolConfigurationsRes.isErr()) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "tool_not_available",
        toolConfigurationsRes.error.message
      )
    );
  }

  // Empty when the tool has been disabled by an admin.
  const [toolConfiguration] = toolConfigurationsRes.value;
  if (!toolConfiguration) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "tool_not_available",
        `Tool ${toolName} is not available.`
      )
    );
  }

  return new Ok({ toolConfiguration, companyConfig });
}

/**
 * Creates a sandbox function MCP action (code running inside a sandbox function invocation
 * calling an MCP tool through the public sandbox API). The workflow is launched immediately when
 * the tool does not require approval; otherwise an approval event is published to the invocation.
 */
export async function createSandboxFunctionMCPAction(
  auth: Authenticator,
  {
    sandboxFunctionId,
    invocationId,
    runtimeSpaceId,
    serverViewId,
    toolName,
    rawInputs,
  }: {
    sandboxFunctionId: string;
    invocationId: string;
    runtimeSpaceId: string;
    serverViewId: string;
    toolName: string;
    rawInputs: Record<string, unknown>;
  }
): Promise<
  Result<
    {
      actionId: string;
      createTimings: SandboxFunctionMcpActionServerTimingsMs;
    },
    SandboxFunctionMCPActionError
  >
> {
  const totalStarted = performance.now();

  const validateInputsResult = validateToolInputs(rawInputs);
  if (validateInputsResult.isErr()) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "invalid_inputs",
        validateInputsResult.error.message
      )
    );
  }

  const fetchViewStarted = performance.now();
  const view = await MCPServerViewResource.fetchById(auth, serverViewId, {
    mode: "configuration",
  });
  const fetchViewMs = roundMs(fetchViewStarted);
  // `fetchById` is workspace-scoped, so reproduce the listing endpoint's confinement: the view
  // must be in the function's runtime or global space (the spaces the listing queries) AND
  // readable by the caller. The permission check keeps this correct if access is revoked within the token
  // TTL; on its own it would not confine, since an admin can administrate any space. Out-of-scope
  // ids report as not-found so the sandbox cannot probe other spaces.
  const inScope = view?.space.sId === runtimeSpaceId || view?.space.isGlobal();
  if (
    !view ||
    !inScope ||
    !(auth.can("read", view) || auth.can("admin", view))
  ) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "server_view_not_found",
        "MCP server view not found."
      )
    );
  }

  const resolveToolStarted = performance.now();
  const toolConfigurationRes = await resolveSandboxFunctionTool(
    auth,
    view,
    toolName
  );
  const resolveToolMs = roundMs(resolveToolStarted);
  if (toolConfigurationRes.isErr()) {
    return toolConfigurationRes;
  }

  // Execution-side resolution: a sandbox-token auth cannot carry the invoker's original grant
  // (e.g. a frame share token). The id comes from signature-verified sandbox JWT claims minted
  // at execution start, so the space filter is deliberately skipped.
  const fetchFunctionStarted = performance.now();
  const sandboxFunction = await SandboxFunctionResource.fetchByIdForExecution(
    auth,
    {
      sandboxFunctionId,
      invocationId,
    }
  );
  const fetchFunctionMs = roundMs(fetchFunctionStarted);
  if (!sandboxFunction) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "invocation_not_found",
        "Sandbox function not found."
      )
    );
  }

  const fetchInvocationStarted = performance.now();
  const invocation = await SandboxFunctionInvocationResource.fetchById(auth, {
    sandboxFunction,
    invocationId,
    access: "system",
  });
  const fetchInvocationMs = roundMs(fetchInvocationStarted);
  if (!invocation) {
    return new Err(
      new SandboxFunctionMCPActionError(
        "invocation_not_found",
        "Sandbox function invocation not found."
      )
    );
  }

  const { toolConfiguration, companyConfig } = toolConfigurationRes.value;
  // Inject company defaults when we have them. Without a company default, keep rawInputs
  // unchanged so callers that already pass configuration URIs (pre-hideInternalConfiguration
  // clients) still work — MCP validation rejects missing required fields.
  const augmentedInputs = companyConfig
    ? getAugmentedInputs(auth, {
        actionConfiguration: toolConfiguration,
        rawInputs,
      })
    : rawInputs;

  const stakeStatusStarted = performance.now();
  const { status: executionStatus } = await getExecutionStatusFromConfig(auth, {
    actionConfiguration: toolConfiguration,
    context: {
      toolInputs: augmentedInputs,
    },
  });
  const stakeStatusMs = roundMs(stakeStatusStarted);

  let actionStatus: "running" | "blocked_validation_required";
  switch (executionStatus) {
    case "ready_allowed_implicitly":
      actionStatus = "running";
      break;
    case "blocked_validation_required":
      actionStatus = "blocked_validation_required";
      break;
    default:
      assertNever(executionStatus);
  }

  const createActionStarted = performance.now();
  const action = await SandboxFunctionMCPActionResource.makeNew(auth, {
    invocation,
    mcpServerView: view,
    toolName,
    inputs: augmentedInputs,
    toolConfiguration: omit(
      toolConfiguration,
      MCP_TOOL_CONFIGURATION_FIELDS_TO_OMIT
    ),
    status: actionStatus,
  });
  const createActionMs = roundMs(createActionStarted);

  const runOrLaunchStarted = performance.now();
  switch (actionStatus) {
    case "running": {
      const launchResult = await launchSandboxFunctionToolWorkflow(auth, {
        action,
      });
      if (launchResult.isErr()) {
        await action.updateStatusFromExpected(auth, {
          status: "errored",
          expectedStatus: "running",
        });
        throw launchResult.error;
      }
      break;
    }
    case "blocked_validation_required": {
      const approvalEventBase = await makeMCPApproveExecutionEventBase(auth, {
        actionId: action.sId,
        toolConfiguration,
        inputs: augmentedInputs,
        approvalSubjectName: sandboxFunction.slug,
      });
      const approvalEvent: SandboxFunctionMCPApproveExecutionEvent = {
        ...approvalEventBase,
        sandboxFunctionId: sandboxFunction.sId,
        invocationId: invocation.sId,
      };

      await publishSandboxFunctionBlockingEvent(auth, approvalEvent, {
        invocation,
      });

      void emitAuditLogEvent({
        auth,
        action: "tool.approval_requested",
        targets: [
          buildAuditLogTarget("workspace", auth.getNonNullableWorkspace()),
          buildAuditLogTarget("tool", {
            sId: toolConfiguration.name,
            name: toolConfiguration.originalName,
          }),
        ],
        context: getAuditLogContext(auth),
        metadata: {
          tool_name: toolConfiguration.originalName,
          mcp_server_name: toolConfiguration.mcpServerName,
          stake_level: toolConfiguration.permission,
          action_id: action.sId,
          ...buildSandboxFunctionAuditMetadata(invocation),
          initiating_user_id: auth.user()?.sId ?? "unknown",
          initiating_user_email: auth.user()?.email ?? "unknown",
        },
      });
      break;
    }
    default:
      assertNever(actionStatus);
  }
  const runOrLaunchMs = roundMs(runOrLaunchStarted);

  const createTimings = {
    fetchView: fetchViewMs,
    resolveTool: resolveToolMs,
    fetchFunction: fetchFunctionMs,
    fetchInvocation: fetchInvocationMs,
    stakeStatus: stakeStatusMs,
    createAction: createActionMs,
    runOrLaunch: runOrLaunchMs,
    total: roundMs(totalStarted),
  };
  logger.info(
    {
      actionId: action.sId,
      invocationId: invocation.sId,
      timingsMs: createTimings,
    },
    "Sandbox function MCP action create phase timings"
  );

  return new Ok({
    actionId: action.sId,
    createTimings,
  });
}
