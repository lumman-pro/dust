import { emitAuditLogEvent } from "@app/lib/api/audit/workos_audit";
import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import { FileResource } from "@app/lib/resources/file_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import {
  createTestConversationFrameFile,
  createTestLiveConversationFrame,
} from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import assert from "assert";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/frames/permissions", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/frames/permissions")>();
  return {
    ...actual,
    canWriteFrameV2Source: vi.fn(actual.canWriteFrameV2Source),
  };
});

vi.mock("@app/lib/api/audit/workos_audit", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/audit/workos_audit")>();
  return { ...actual, emitAuditLogEvent: vi.fn() };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(emitAuditLogEvent).mockClear();
});

describe("enterFrameDraftMode", () => {
  it("turns draft mode on for the caller, leaving both pointers alone", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const { frame } = await createTestLiveConversationFrame(auth);

    const result = await enterFrameDraftMode(auth, { frame });

    assert(result.isOk(), "draft mode is on");
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(true);
    expect(reloaded?.useCaseMetadata?.frameDraftMode?.enabledByUserSId).toBe(
      auth.getNonNullableUser().sId
    );
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(
      "publication-live"
    );
    expect(reloaded?.useCaseMetadata?.latestPublicationId).toBe(
      "publication-live"
    );
  });

  it("audits turning draft mode on, once", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const { frame } = await createTestLiveConversationFrame(auth);

    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    assert((await enterFrameDraftMode(auth, { frame })).isOk());

    expect(emitAuditLogEvent).toHaveBeenCalledTimes(1);
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_mode_updated",
        metadata: { frame_id: frame.sId, draft_mode: "on" },
      })
    );
  });

  it("keeps who turned draft mode on when it is entered again", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const { frame } = await createTestLiveConversationFrame(auth);
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const first = (await FileResource.fetchById(auth, frame.sId))
      ?.useCaseMetadata?.frameDraftMode;

    const again = await enterFrameDraftMode(auth, { frame });

    assert(again.isOk(), "entering again succeeds");
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.frameDraftMode).toEqual(first);
  });

  it("refuses a Frame with no live publication", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const conversation = await ConversationFactory.create(auth, {
      agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
      messagesCreatedAt: [new Date()],
    });
    const frame = await createTestConversationFrameFile(auth, {
      conversationId: conversation.sId,
    });

    const result = await enterFrameDraftMode(auth, { frame });

    assert(result.isErr(), "draft mode is refused");
    expect(result.error).toMatchObject({ code: "frame_not_published" });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("refuses a caller who cannot write the Frame", async () => {
    const { authenticator: auth } = await createResourceTest({});
    const { frame } = await createTestLiveConversationFrame(auth);
    vi.mocked(canWriteFrameV2Source).mockResolvedValueOnce(false);

    const result = await enterFrameDraftMode(auth, { frame });

    assert(result.isErr(), "draft mode is refused");
    expect(result.error).toMatchObject({ code: "unauthorized" });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
    expect(emitAuditLogEvent).not.toHaveBeenCalled();
  });
});
