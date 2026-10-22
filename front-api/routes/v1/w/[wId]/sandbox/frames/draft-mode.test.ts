import { FileResource } from "@app/lib/resources/file_resource";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import {
  createTestConversationFrameFile,
  createTestLiveConversationFrame,
} from "@app/tests/utils/FrameFunctionFactory";
import { createSandboxTokenTestContext } from "@app/tests/utils/SandboxTokenFactory";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import { honoApp } from "@front-api/app";
import { describe, expect, it } from "vitest";

async function setup({ draftsEnabled = true } = {}) {
  const context = await createSandboxTokenTestContext();
  if (draftsEnabled) {
    await FeatureFlagFactory.basic(context.auth, "frames_v2_drafts");
  }
  return context;
}

// Scoped path of the factory's Frame folder in a conversation.
function manifestPathIn(conversationId: string): string {
  return `conversation-${conversationId}/Frame/${FRAME_MANIFEST_FILE}`;
}

function requestDraftMode(
  context: Awaited<ReturnType<typeof setup>>,
  manifestPath: string
) {
  return honoApp.request(
    `/api/v1/w/${context.workspace.sId}/sandbox/frames/draft-mode`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${context.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ manifestPath }),
    }
  );
}

describe("POST /api/v1/w/[wId]/sandbox/frames/draft-mode", () => {
  it("turns draft mode on for a published Frame in the token's conversation", async () => {
    const context = await setup();
    const frame = await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
      activePublicationId: "publication-live",
    });
    const manifestPath = manifestPathIn(context.conversation.sId);

    const response = await requestDraftMode(context, manifestPath);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      frameId: frame.sId,
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(
      "publication-live"
    );
  });

  it("returns 403 frame_not_in_conversation for a Frame in another conversation", async () => {
    const context = await setup();
    const { conversation: other, frame } =
      await createTestLiveConversationFrame(context.auth);

    const response = await requestDraftMode(context, manifestPathIn(other.sId));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_in_conversation" },
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("returns 404 when no Frame is registered at the path", async () => {
    const context = await setup();

    const response = await requestDraftMode(
      context,
      `conversation-${context.conversation.sId}/Missing/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "file_not_found" },
    });
  });

  it("returns 400 for a path that is not a manifest", async () => {
    const context = await setup();
    await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
      activePublicationId: "publication-live",
    });

    const response = await requestDraftMode(
      context,
      `conversation-${context.conversation.sId}/Frame/index.tsx`
    );

    expect(response.status).toBe(400);
  });

  it("returns 409 frame_not_published for a Frame with nothing live", async () => {
    const context = await setup();
    await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
    });
    const manifestPath = manifestPathIn(context.conversation.sId);

    const response = await requestDraftMode(context, manifestPath);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_published" },
    });
  });

  it("returns 403 when drafts are not enabled, leaving draft mode off", async () => {
    const context = await setup({ draftsEnabled: false });
    const frame = await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
      activePublicationId: "publication-live",
    });
    const manifestPath = manifestPathIn(context.conversation.sId);

    const response = await requestDraftMode(context, manifestPath);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "feature_not_enabled" },
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });
});
