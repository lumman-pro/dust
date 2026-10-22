import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { FileResource } from "@app/lib/resources/file_resource";
import {
  createTestConversationFrameFile,
  createTestLiveConversationFrame,
} from "@app/tests/utils/FrameFunctionFactory";
import { publishTestFrameBundle } from "@app/tests/utils/FramePublicationFactory";
import { createSandboxTokenTestContext } from "@app/tests/utils/SandboxTokenFactory";
import { FRAME_MANIFEST_FILE } from "@app/types/api/frame_manifest";
import { honoApp } from "@front-api/app";
import assert from "assert";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/lock", async (importActual) => {
  const actual = await importActual<typeof import("@app/lib/lock")>();
  return {
    ...actual,
    executeWithLock: async <T>(_name: string, cb: () => Promise<T>) => cb(),
  };
});

function requestMakeLive(
  context: Awaited<ReturnType<typeof createSandboxTokenTestContext>>,
  manifestPath: string
) {
  return honoApp.request(
    `/api/v1/w/${context.workspace.sId}/sandbox/frames/make-live`,
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/v1/w/[wId]/sandbox/frames/make-live", () => {
  it("makes the Frame's pending draft live, whoever published it, and ends draft mode", async () => {
    const context = await createSandboxTokenTestContext();
    const frame = await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
    });
    await publishTestFrameBundle(context.auth, {
      frame,
      uiBundleCode: "export default () => 'A';",
      mode: "live",
    });
    assert((await enterFrameDraftMode(context.auth, { frame })).isOk());
    const draftId = await publishTestFrameBundle(context.auth, {
      frame,
      uiBundleCode: "export default () => 'B';",
      mode: "draft",
    });

    const response = await requestMakeLive(
      context,
      `conversation-${context.conversation.sId}/Frame/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      frameId: frame.sId,
      publicationId: draftId,
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(draftId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("only ends draft mode when nothing changed in it", async () => {
    const context = await createSandboxTokenTestContext();
    const frame = await createTestConversationFrameFile(context.auth, {
      conversationId: context.conversation.sId,
    });
    const liveId = await publishTestFrameBundle(context.auth, {
      frame,
      uiBundleCode: "export default () => 'A';",
      mode: "live",
    });
    assert((await enterFrameDraftMode(context.auth, { frame })).isOk());
    const activate = vi.spyOn(
      FileResource.prototype,
      "setActiveFramePublication"
    );

    const response = await requestMakeLive(
      context,
      `conversation-${context.conversation.sId}/Frame/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      publicationId: liveId,
    });
    expect(activate).not.toHaveBeenCalled();
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("returns 403 frame_not_in_conversation for a Frame in another conversation", async () => {
    const context = await createSandboxTokenTestContext();
    const { conversation: other, frame } =
      await createTestLiveConversationFrame(context.auth);
    assert((await enterFrameDraftMode(context.auth, { frame })).isOk());

    const response = await requestMakeLive(
      context,
      `conversation-${other.sId}/Frame/${FRAME_MANIFEST_FILE}`
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_in_conversation" },
    });
    const reloaded = await FileResource.fetchById(context.auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
  });
});
