import { FileResource } from "@app/lib/resources/file_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import {
  createTestConversationFrameFile,
  createTestLiveConversationFrame,
} from "@app/tests/utils/FrameFunctionFactory";
import { createPrivateApiMockRequest } from "@app/tests/utils/generic_private_api_tests";
import { honoApp } from "@front-api/app";
import { describe, expect, it } from "vitest";

function postDraftMode(workspaceId: string, frameId: string) {
  return honoApp.request(`/api/w/${workspaceId}/frames/${frameId}/draft-mode`, {
    method: "POST",
  });
}

describe("POST /api/w/:wId/frames/:frameId/draft-mode", () => {
  it("turns draft mode on for an editor", async () => {
    const { auth, workspace } = await createPrivateApiMockRequest({
      role: "admin",
    });
    await FeatureFlagFactory.basic(auth, "frames_v2_drafts");
    const { frame } = await createTestLiveConversationFrame(auth);

    const response = await postDraftMode(workspace.sId, frame.sId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ draftMode: true });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
  });

  it("returns 403 when drafts are not enabled, leaving draft mode off", async () => {
    const { auth, workspace } = await createPrivateApiMockRequest({
      role: "admin",
    });
    const { frame } = await createTestLiveConversationFrame(auth);

    const response = await postDraftMode(workspace.sId, frame.sId);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "feature_not_enabled" },
    });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("returns 409 frame_not_published for a Frame with nothing live", async () => {
    const { auth, workspace } = await createPrivateApiMockRequest({
      role: "admin",
    });
    await FeatureFlagFactory.basic(auth, "frames_v2_drafts");
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: "test-agent",
      messagesCreatedAt: [],
    });
    const frame = await createTestConversationFrameFile(auth, {
      conversationId: conversation.sId,
    });

    const response = await postDraftMode(workspace.sId, frame.sId);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_published" },
    });
  });

  it("returns 404 for a Frame that does not exist", async () => {
    const { auth, workspace } = await createPrivateApiMockRequest({
      role: "admin",
    });
    await FeatureFlagFactory.basic(auth, "frames_v2_drafts");

    const response = await postDraftMode(workspace.sId, "fil_missing0000");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "file_not_found" },
    });
  });
});
