import { getRedisHybridManager } from "@app/lib/api/redis-hybrid-manager";
import { SandboxFunctionMCPActionResource } from "@app/lib/resources/sandbox_function_mcp_action_resource";
import {
  createTestFrameFile,
  makeTestFrameBlockedAction,
} from "@app/tests/utils/FrameFunctionFactory";
import { createPrivateApiMockRequest } from "@app/tests/utils/generic_private_api_tests";
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

function postValidate({
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
    `/api/w/${workspaceId}/frames/${frameId}/invocations/${invocationId}/actions/${actionId}/validate-action`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved: "approved" }),
    }
  );
}

describe("POST /api/w/:wId/frames/:frameId/invocations/:invocationId/actions/:actionId/validate-action", () => {
  it("approves a blocked action and launches its workflow", async () => {
    const { workspace, frame, invocation, action, adminAuth } =
      await makeTestFrameBlockedAction();

    const response = await postValidate({
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

  it("approves an in-flight action after the Frame republishes", async () => {
    const { workspace, frame, invocation, action } =
      await makeTestFrameBlockedAction();
    await frame.setActiveFramePublication({
      publicationId: "publication-2",
      description: "Track tasks.",
    });

    const response = await postValidate({
      workspaceId: workspace.sId,
      frameId: frame.sId,
      invocationId: invocation.sId,
      actionId: action.sId,
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(launchSandboxFunctionToolWorkflow)).toHaveBeenCalledOnce();
  });

  it("hides an invocation of another Frame", async () => {
    const { workspace, invocation, action, adminAuth, space } =
      await makeTestFrameBlockedAction();
    const otherFrame = await createTestFrameFile(adminAuth, { space });

    const response = await postValidate({
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

  it("hides another user's invocation", async () => {
    const { workspace, frame, invocation, action } =
      await makeTestFrameBlockedAction();
    // The last mock request owns the route session.
    await createPrivateApiMockRequest({ role: "user", workspace });

    const response = await postValidate({
      workspaceId: workspace.sId,
      frameId: frame.sId,
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
