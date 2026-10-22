import { getRedisHybridManager } from "@app/lib/api/redis-hybrid-manager";
import { cancelPendingSandboxFunctionBlockedActions } from "@app/lib/api/sandbox_functions/cancel_pending_blocked_actions";
import { SandboxFunctionInvocationResource } from "@app/lib/resources/sandbox_function_invocation_resource";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import { createTestFrameFunction } from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { MCPServerViewFactory } from "@app/tests/utils/MCPServerViewFactory";
import { RemoteMCPServerFactory } from "@app/tests/utils/RemoteMCPServerFactory";
import { SandboxFunctionMCPActionFactory } from "@app/tests/utils/SandboxFunctionMCPActionFactory";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import { describe, expect, it, vi } from "vitest";

describe("cancelPendingSandboxFunctionBlockedActions", () => {
  it("denies blocked actions and removes their redis events", async () => {
    const { authenticator, workspace, globalSpace } = await createResourceTest({
      role: "admin",
    });
    const podSpace = await SpaceFactory.project(workspace);
    const { sandboxFunction } = await createTestFrameFunction(authenticator, {
      space: podSpace,
    });
    const invocation = await SandboxFunctionInvocationResource.makeNew(
      authenticator,
      { sandboxFunction, input: undefined }
    );
    const server = await RemoteMCPServerFactory.create(workspace);
    const mcpServerView = await MCPServerViewFactory.create(
      workspace,
      server.sId,
      globalSpace
    );
    const action = await SandboxFunctionMCPActionFactory.create(authenticator, {
      invocation,
      mcpServerView,
      status: "blocked_validation_required",
      permission: "high",
    });

    const removeEvent = vi.spyOn(getRedisHybridManager(), "removeEvent");

    await cancelPendingSandboxFunctionBlockedActions(authenticator, invocation);

    const refetched = await SandboxFunctionMCPActionResource.fetchById(
      authenticator,
      action.sId
    );
    expect(refetched?.status).toBe("denied");
    expect(removeEvent).toHaveBeenCalled();
  });

  it("is a no-op when no blocked actions remain", async () => {
    const { authenticator, workspace } = await createResourceTest({
      role: "admin",
    });
    const podSpace = await SpaceFactory.project(workspace);
    const { sandboxFunction } = await createTestFrameFunction(authenticator, {
      space: podSpace,
    });
    const invocation = await SandboxFunctionInvocationResource.makeNew(
      authenticator,
      { sandboxFunction, input: undefined }
    );

    const removeEvent = vi.spyOn(getRedisHybridManager(), "removeEvent");

    await cancelPendingSandboxFunctionBlockedActions(authenticator, invocation);

    expect(removeEvent).not.toHaveBeenCalled();
  });
});
