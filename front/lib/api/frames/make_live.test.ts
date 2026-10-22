import { emitAuditLogEvent } from "@app/lib/api/audit/workos_audit";
import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { makeFrameDraftLive } from "@app/lib/api/frames/make_live";
import { canWriteFrameV2Source } from "@app/lib/api/frames/permissions";
import type { FramePublicationFunctionArtifact } from "@app/lib/api/frames/publication_storage";
import { publishFramePublication } from "@app/lib/api/frames/publication_storage";
import { seedFramePublicationFunctionsArchive } from "@app/lib/api/frames/seed_functions_archive";
import type { Authenticator } from "@app/lib/auth";
import { FileResource } from "@app/lib/resources/file_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import {
  createTestConversationFrameFile,
  enablePublicFrameFunctions,
  makeTestFrameFunction,
} from "@app/tests/utils/FrameFunctionFactory";
import { createResourceTest } from "@app/tests/utils/generic_resource_tests";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import { FrameManifestSchema } from "@app/types/api/frame_manifest";
import { GLOBAL_AGENTS_SID } from "@app/types/assistant/assistant";
import type { Result } from "@app/types/shared/result";
import assert from "assert";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@app/lib/api/frames/seed_functions_archive", () => ({
  seedFramePublicationFunctionsArchive: vi.fn().mockResolvedValue(undefined),
}));

// Records which Frame operation locks are held, so tests can check what runs under them.
const { heldFrameLocks } = vi.hoisted(() => ({
  heldFrameLocks: new Set<"source" | "publish">(),
}));

vi.mock("@app/lib/api/frames/operation_lock", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/frames/operation_lock")>();
  return {
    ...actual,
    withFrameSourceLock: <T, E>(
      frameId: string,
      callback: () => Promise<Result<T, E>>
    ) =>
      actual.withFrameSourceLock(frameId, async () => {
        heldFrameLocks.add("source");
        try {
          return await callback();
        } finally {
          heldFrameLocks.delete("source");
        }
      }),
    withFramePublishLock: <T, E>(
      frameId: string,
      callback: () => Promise<Result<T, E>>
    ) =>
      actual.withFramePublishLock(frameId, async () => {
        heldFrameLocks.add("publish");
        try {
          return await callback();
        } finally {
          heldFrameLocks.delete("publish");
        }
      }),
  };
});

vi.mock("@app/lib/api/audit/workos_audit", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/audit/workos_audit")>();
  return { ...actual, emitAuditLogEvent: vi.fn() };
});

vi.mock("@app/lib/api/frames/permissions", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/frames/permissions")>();
  return {
    ...actual,
    canWriteFrameV2Source: vi.fn(actual.canWriteFrameV2Source),
  };
});

async function setupFrame(): Promise<{
  frame: FileResource;
  auth: Authenticator;
}> {
  const { authenticator } = await createResourceTest({});
  await FeatureFlagFactory.basic(authenticator, "frames_v2_drafts");
  const conversation = await ConversationFactory.create(authenticator, {
    agentConfigurationId: GLOBAL_AGENTS_SID.DUST,
    messagesCreatedAt: [new Date()],
  });
  const frame = await createTestConversationFrameFile(authenticator, {
    conversationId: conversation.sId,
  });

  return { auth: authenticator, frame };
}

const manifest = FrameManifestSchema.parse({
  version: 1,
  description: "Track tasks.",
});

const manifestWithFunction = FrameManifestSchema.parse({
  version: 1,
  description: "Track tasks.",
  functions: [
    {
      name: "add-task",
      description: "Add a task.",
      entryPoint: "functions/add_task.ts",
    },
  ],
});

const sourceFiles = [
  {
    relativePath: "index.tsx",
    content: Buffer.from("export default function App() {}"),
    contentType: "text/typescript" as const,
  },
  {
    relativePath: "data.json",
    content: Buffer.from("{}"),
    contentType: "application/json" as const,
  },
];

const sourceFilesWithFunction = [
  ...sourceFiles,
  {
    relativePath: "functions/add_task.ts",
    content: Buffer.from("export async function run() {}"),
    contentType: "text/typescript" as const,
  },
];

const functionArtifacts = [
  {
    name: "add-task",
    bundleCode: "export async function run() {}",
    userIdentity: "workspace_user_required",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
    },
    outputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
] satisfies FramePublicationFunctionArtifact[];

const CODE_A = "export default function A() {}";
const CODE_B = "export default function B() {}";
const CODE_C = "export default function C() {}";

async function publishBundle(
  auth: Authenticator,
  frame: FileResource,
  code: string,
  mode: "live" | "draft"
): Promise<string> {
  const published = await publishFramePublication(auth, {
    frame,
    functionArtifacts: [],
    manifest,
    sourceFiles,
    uiBundleCode: code,
    mode,
  });
  assert(published.isOk(), "publish succeeds");
  return published.value.publicationId;
}

async function metadataOf(auth: Authenticator, frame: FileResource) {
  return (await FileResource.fetchById(auth, frame.sId))?.useCaseMetadata;
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.mocked(seedFramePublicationFunctionsArchive).mockResolvedValue(undefined);
  fileStorageMock.reset();
});

describe("makeFrameDraftLive", () => {
  it("makes the draft live, pointing both pointers at it", async () => {
    const { auth, frame } = await setupFrame();
    await publishBundle(auth, frame, CODE_A, "live");
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    expect(result.isOk() && result.value).toEqual({ publicationId: draftId });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(draftId);
    expect(metadata?.latestPublicationId).toBe(draftId);
  });

  it("refuses a draft id that is no longer the pending draft", async () => {
    const { auth, frame } = await setupFrame();
    const liveId = await publishBundle(auth, frame, CODE_A, "live");
    const staleDraftId = await publishBundle(auth, frame, CODE_B, "draft");
    const pendingDraftId = await publishBundle(auth, frame, CODE_C, "draft");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: staleDraftId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "draft_conflict" });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(liveId);
    expect(metadata?.latestPublicationId).toBe(pendingDraftId);
  });

  it("succeeds when the draft is already live", async () => {
    const { auth, frame } = await setupFrame();
    await publishBundle(auth, frame, CODE_A, "live");
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");

    const first = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });
    const second = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    expect(first.isOk() && first.value).toEqual({ publicationId: draftId });
    expect(second.isOk() && second.value).toEqual({ publicationId: draftId });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(draftId);
    expect(metadata?.latestPublicationId).toBe(draftId);
  });

  it("ends draft mode when it makes the draft live", async () => {
    const { auth, frame } = await setupFrame();
    await publishBundle(auth, frame, CODE_A, "live");
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isOk(), "make live succeeds");
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.frameDraftMode).toBeUndefined();
    expect(reloaded?.isInFrameDraftMode).toBe(false);
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_mode_updated",
        metadata: { frame_id: frame.sId, draft_mode: "off" },
      })
    );
  });

  it("ends draft mode without re-activating when nothing changed in it", async () => {
    const { auth, frame } = await setupFrame();
    const liveId = await publishBundle(auth, frame, CODE_A, "live");
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const activate = vi.spyOn(
      FileResource.prototype,
      "setActiveFramePublication"
    );

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: liveId,
    });

    expect(result.isOk() && result.value).toEqual({ publicationId: liveId });
    expect(activate).not.toHaveBeenCalled();
    expect(emitAuditLogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "frame.draft_mode_updated",
        metadata: { frame_id: frame.sId, draft_mode: "off" },
      })
    );
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded?.useCaseMetadata?.latestPublicationId).toBe(liveId);
  });

  it("refuses the live publication while a newer draft is pending", async () => {
    const { auth, frame } = await setupFrame();
    const liveId = await publishBundle(auth, frame, CODE_A, "live");
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: liveId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "draft_conflict" });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(reloaded?.useCaseMetadata?.latestPublicationId).toBe(draftId);
    expect(reloaded?.useCaseMetadata?.frameDraftMode).toBeDefined();
  });

  it("makes the latest publication live when the caller names none", async () => {
    const { auth, frame } = await setupFrame();
    await publishBundle(auth, frame, CODE_A, "live");
    assert((await enterFrameDraftMode(auth, { frame })).isOk());
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");

    const result = await makeFrameDraftLive(auth, { frame });

    expect(result.isOk() && result.value).toEqual({ publicationId: draftId });
    const reloaded = await FileResource.fetchById(auth, frame.sId);
    expect(reloaded?.useCaseMetadata?.activePublicationId).toBe(draftId);
    expect(reloaded?.isInFrameDraftMode).toBe(false);
  });

  it("refuses when there is no pending draft", async () => {
    const { auth, frame } = await setupFrame();
    const liveId = await publishBundle(auth, frame, CODE_A, "live");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: "anything",
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "draft_conflict" });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(liveId);
    expect(metadata?.latestPublicationId).toBe(liveId);
  });

  it("refuses when the Frame is deleted before the locks are taken", async () => {
    const { auth, frame } = await setupFrame();
    await publishBundle(auth, frame, CODE_A, "live");
    const draftId = await publishBundle(auth, frame, CODE_B, "draft");
    vi.spyOn(FileResource.prototype, "fetchFreshFrameV2").mockResolvedValue(
      null
    );

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "frame_not_found" });
  });

  it("re-checks write access on the Frame read under the locks", async () => {
    const { auth, frame } = await makeTestFrameFunction();
    const draftId = "draft-publication-1";
    await frame.setLatestFramePublication({ publicationId: draftId });
    vi.mocked(canWriteFrameV2Source).mockClear();
    let locksHeldDuringCheck: string[] = [];
    vi.mocked(canWriteFrameV2Source).mockImplementationOnce(async () => {
      locksHeldDuringCheck = [...heldFrameLocks].sort();
      return false;
    });

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "make live is refused");
    // The single check ran on the Frame read under the locks, not on the caller's copy.
    expect(canWriteFrameV2Source).toHaveBeenCalledTimes(1);
    expect(locksHeldDuringCheck).toEqual(["publish", "source"]);
    expect(vi.mocked(canWriteFrameV2Source).mock.calls[0][1]).not.toBe(frame);
    expect(result.error).toMatchObject({ code: "unauthorized" });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe("publication-1");
    expect(metadata?.latestPublicationId).toBe(draftId);
  });

  it("refuses a caller who cannot write the Frame", async () => {
    const { auth, frame } = await makeTestFrameFunction();
    const draftId = "draft-publication-1";
    await frame.setLatestFramePublication({ publicationId: draftId });

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "unauthorized" });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe("publication-1");
    expect(metadata?.latestPublicationId).toBe(draftId);
  });

  it("fails on the function sharing check like a publish would", async () => {
    const { auth, frame } = await setupFrame();
    await FeatureFlagFactory.basic(auth, "frames_v2_functions");
    const liveId = await publishBundle(auth, frame, CODE_A, "live");
    const published = await publishFramePublication(auth, {
      frame,
      functionArtifacts,
      manifest: manifestWithFunction,
      sourceFiles: sourceFilesWithFunction,
      uiBundleCode: CODE_B,
      mode: "draft",
    });
    assert(published.isOk(), "draft publish succeeds");
    const draftId = published.value.publicationId;
    await frame.setShareScope(auth, "public");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "sharing_conflict" });
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(liveId);
    expect(metadata?.latestPublicationId).toBe(draftId);
  });

  it("refuses a draft with no public function onto a public share", async () => {
    const { auth, frame } = await setupFrame();
    await enablePublicFrameFunctions(auth);
    const liveId = await publishBundle(auth, frame, CODE_A, "live");
    const published = await publishFramePublication(auth, {
      frame,
      functionArtifacts,
      manifest: manifestWithFunction,
      sourceFiles: sourceFilesWithFunction,
      uiBundleCode: CODE_B,
      mode: "draft",
    });
    assert(published.isOk(), "draft publish succeeds");
    const draftId = published.value.publicationId;
    await frame.setShareScope(auth, "public");

    const result = await makeFrameDraftLive(auth, {
      frame,
      draftPublicationId: draftId,
    });

    assert(result.isErr(), "make live is refused");
    expect(result.error).toMatchObject({ code: "sharing_conflict" });
    expect(result.error.message).toContain("none of its functions declares");
    const metadata = await metadataOf(auth, frame);
    expect(metadata?.activePublicationId).toBe(liveId);
  });
});
