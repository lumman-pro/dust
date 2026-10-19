import { getRedisHybridManager } from "@app/lib/api/redis-hybrid-manager";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import {
  createTestFrameFile,
  makeTestFrameBlockedAction,
} from "@app/tests/utils/FrameFunctionFactory";
import { Ok } from "@app/types/shared/result";
import { honoApp } from "@front-api/app";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/temporal/sandbox_functions/client", async (importOriginal) => {
  const mod =
    await importOriginal<
      typeof import("@app/temporal/sandbox_functions/client")
    >();
  return {
    ...mod,
    launchSandboxFunctionToolWorkflow: vi.fn(async () => new Ok(undefined)),
  };
});

import { launchSandboxFunctionToolWorkflow } from "@app/temporal/sandbox_functions/client";

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(getRedisHybridManager(), "removeEvent").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function postResolveAuthentication({
  workspaceId,
  frameId,
  invocationId,
  actionId,
}: {
  workspaceId: string;
  frameId: string;
  invocationId: string;
  actionId: string;
}) {
  return honoApp.request(
    `/api/w/${workspaceId}/frames/${frameId}/invocations/${invocationId}/actions/${actionId}/resolve-authentication`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ outcome: "completed" }),
    }
  );
}

describe("POST /api/w/:wId/frames/:frameId/invocations/:invocationId/actions/:actionId/resolve-authentication", () => {
  it("completes authentication and relaunches the workflow", async () => {
    const { workspace, frame, invocation, action, adminAuth } =
      await makeTestFrameBlockedAction({
        blockedStatus: "blocked_authentication_required",
      });

    const response = await postResolveAuthentication({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      invocationId: invocation.sId,
      actionId: action.sId,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    const refetched =
      await SandboxFunctionMCPActionResource.fetchByModelIdWithAuth(
        adminAuth,
        action.id
      );
    expect(refetched?.status).toBe("running");
    expect(vi.mocked(launchSandboxFunctionToolWorkflow)).toHaveBeenCalledWith(
      expect.anything(),
      { action: expect.objectContaining({ sId: action.sId }) }
    );
  });

  it("hides an invocation of another Frame", async () => {
    const { workspace, invocation, action, adminAuth, space } =
      await makeTestFrameBlockedAction({
        blockedStatus: "blocked_authentication_required",
      });
    const otherFrame = await createTestFrameFile(adminAuth, { space });

    const response = await postResolveAuthentication({
      workspaceId: workspace.sId,
      frameId: otherFrame.sId,
      invocationId: invocation.sId,
      actionId: action.sId,
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error: { type: "sandbox_function_invocation_not_found" },
    });
    expect(vi.mocked(launchSandboxFunctionToolWorkflow)).not.toHaveBeenCalled();
  });
});
