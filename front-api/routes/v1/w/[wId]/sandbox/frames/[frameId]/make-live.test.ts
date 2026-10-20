// Frame publishing runs esbuild, whose TextEncoder invariant requires Node rather than jsdom.
// @vitest-environment node

import { enterFrameDraftMode } from "@app/lib/api/frames/draft_mode";
import { publishFramePublication } from "@app/lib/api/frames/publication_storage";
import type { Authenticator } from "@app/lib/auth";
import { AgentMCPActionResource } from "@app/lib/resources/agent_mcp_action_resource";
import { FileResource } from "@app/lib/resources/file_resource";
import { ConversationFactory } from "@app/tests/utils/ConversationFactory";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import { createTestConversationFrameFile } from "@app/tests/utils/FrameFunctionFactory";
import { fileStorageMock } from "@app/tests/utils/mocks/file_storage";
import {
  createPersistedSandboxActionToken,
  createSandboxFunctionInvocationTokenTestContext,
  createSandboxTokenTestContext,
} from "@app/tests/utils/SandboxTokenFactory";
import {
  FRAME_MANIFEST_FILE,
  FrameManifestSchema,
} from "@app/types/api/frame_manifest";
import { frameV2ContentType } from "@app/types/files";
import { getConversationFilesBasePath } from "@app/types/mount_path";
import { honoApp } from "@front-api/app";
import assert from "assert";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("@app/lib/lock", async (importActual) => {
  const actual = await importActual<typeof import("@app/lib/lock")>();
  return {
    ...actual,
    executeWithLock: async <T>(_name: string, cb: () => Promise<T>) => cb(),
  };
});

const manifest = JSON.stringify({
  version: 1,
  name: "Status",
  description: "Show the current status.",
});
const uiSource = "export default function Status() { return <p>Ready</p>; }";
const FRAME_FOLDER = "Status";

function postJson(path: string, token: string, body: unknown) {
  return honoApp.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function requestFramePublish(
  workspaceId: string,
  token: string,
  manifestPath: string
) {
  return postJson(`/api/v1/w/${workspaceId}/sandbox/frames/publish`, token, {
    manifestPath,
  });
}

function requestMakeLive(
  workspaceId: string,
  token: string,
  frameId: string,
  body: unknown
) {
  return postJson(
    `/api/v1/w/${workspaceId}/sandbox/frames/${frameId}/make-live`,
    token,
    body
  );
}

const FramePublishResponseSchema = z.object({
  publicationId: z.string(),
  status: z.string(),
});

// Serves the Frame's manifest and `index.tsx` (with `uiCode`) from the storage mock.
function mockFrameSource(mountDirectoryPath: string, uiCode: string) {
  const sourceByPath = new Map([
    [`${mountDirectoryPath}/${FRAME_MANIFEST_FILE}`, manifest],
    [`${mountDirectoryPath}/index.tsx`, uiCode],
  ]);
  fileStorageMock.setFileContent((path) => sourceByPath.get(path) ?? null);
  fileStorageMock.setFilesByPrefix((prefix) =>
    prefix === `${mountDirectoryPath}/`
      ? [...sourceByPath.entries()].map(([name, content]) => ({
          name,
          metadata: {
            contentType: name.endsWith(".tsx")
              ? "text/typescript"
              : "application/json",
            size: String(Buffer.byteLength(content)),
          },
        }))
      : null
  );
}

// Attaching the Frame to its parent action needs a persisted one.
async function setup() {
  const context = await createSandboxTokenTestContext();
  await FeatureFlagFactory.basic(context.auth, "frames_v2");
  await FeatureFlagFactory.basic(context.auth, "frames_v2_drafts");
  const { parentAction, token } =
    await createPersistedSandboxActionToken(context);

  const frame = await createTestConversationFrameFile(context.auth, {
    conversationId: context.conversation.sId,
    folderName: FRAME_FOLDER,
  });
  const mountDirectoryPath = `${getConversationFilesBasePath({
    workspaceId: context.workspace.sId,
    conversationId: context.conversation.sId,
  })}${FRAME_FOLDER}`;
  mockFrameSource(mountDirectoryPath, uiSource);

  return {
    ...context,
    frame,
    manifestPath: `conversation-${context.conversation.sId}/${FRAME_FOLDER}/${FRAME_MANIFEST_FILE}`,
    mountDirectoryPath,
    parentAction,
    token,
  };
}

async function publishFrame(context: Awaited<ReturnType<typeof setup>>) {
  const response = await requestFramePublish(
    context.workspace.sId,
    context.token,
    context.manifestPath
  );
  expect(response.status).toBe(200);
  return FramePublishResponseSchema.parse(await response.json());
}

// Publishes the Frame live, turns draft mode on, publishes a changed draft, and returns both
// publication ids.
async function publishLiveThenDraft(
  context: Awaited<ReturnType<typeof setup>>
) {
  const live = await publishFrame(context);
  const draftMode = await enterFrameDraftMode(context.auth, {
    frame: context.frame,
  });
  assert(draftMode.isOk(), "draft mode is on");
  mockFrameSource(
    context.mountDirectoryPath,
    uiSource.replace("Ready", "Almost ready")
  );
  const draft = await publishFrame(context);
  expect(draft.status).toBe("draft");

  return {
    livePublicationId: live.publicationId,
    draftPublicationId: draft.publicationId,
  };
}

// Publishes through the lib, for a Frame the token's conversation cannot reach.
async function publishBundleDirectly(
  auth: Authenticator,
  frame: FileResource,
  uiBundleCode: string,
  mode: "live" | "draft"
): Promise<string> {
  const published = await publishFramePublication(auth, {
    frame,
    functionArtifacts: [],
    manifest: FrameManifestSchema.parse(JSON.parse(manifest)),
    sourceFiles: [
      {
        relativePath: "index.tsx",
        content: Buffer.from(uiSource),
        contentType: "text/typescript",
      },
    ],
    uiBundleCode,
    mode,
  });
  assert(published.isOk(), "publish succeeds");
  expect(published.value.status).toBe(mode);
  return published.value.publicationId;
}

async function listGeneratedFiles(context: Awaited<ReturnType<typeof setup>>) {
  const [enrichedParent] =
    await AgentMCPActionResource.enrichActionsWithOutputItems(context.auth, {
      actions: [context.parentAction],
      ignoreContent: false,
    });
  return enrichedParent.generatedFiles;
}

beforeEach(() => {
  fileStorageMock.reset();
});

describe("POST /api/v1/w/[wId]/sandbox/frames/[frameId]/make-live", () => {
  it("makes the pending draft live, ends draft mode and attaches the Frame to the parent action", async () => {
    const context = await setup();
    const { draftPublicationId } = await publishLiveThenDraft(context);
    // Each publish attaches the Frame to the parent action; make-live must attach it once more.
    const generatedFilesBefore = await listGeneratedFiles(context);

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      context.frame.sId,
      { publicationId: draftPublicationId }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      frameId: context.frame.sId,
      publicationId: draftPublicationId,
      status: "live",
    });
    const frame = await FileResource.fetchById(context.auth, context.frame.sId);
    expect(frame?.useCaseMetadata?.activePublicationId).toBe(
      draftPublicationId
    );
    expect(frame?.useCaseMetadata?.latestPublicationId).toBe(
      draftPublicationId
    );
    expect(frame?.isInFrameDraftMode).toBe(false);

    const generatedFilesAfter = await listGeneratedFiles(context);
    expect(generatedFilesAfter).toHaveLength(generatedFilesBefore.length + 1);
    expect(generatedFilesAfter.at(-1)).toMatchObject({
      fileId: context.frame.sId,
      contentType: frameV2ContentType,
    });
  });

  it("returns 409 when the publication id is stale", async () => {
    const context = await setup();
    const { livePublicationId, draftPublicationId } =
      await publishLiveThenDraft(context);
    mockFrameSource(
      context.mountDirectoryPath,
      uiSource.replace("Ready", "Newer")
    );
    const { publicationId: newerDraftId } = await publishFrame(context);
    expect(newerDraftId).not.toBe(draftPublicationId);

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      context.frame.sId,
      { publicationId: draftPublicationId }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_draft_conflict" },
    });
    const frame = await FileResource.fetchById(context.auth, context.frame.sId);
    expect(frame?.useCaseMetadata?.activePublicationId).toBe(livePublicationId);
    expect(frame?.useCaseMetadata?.latestPublicationId).toBe(newerDraftId);
  });

  it("returns 409 when the Frame has no pending draft", async () => {
    const context = await setup();
    const { publicationId: livePublicationId } = await publishFrame(context);

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      context.frame.sId,
      { publicationId: "anything" }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_draft_conflict" },
    });
    const frame = await FileResource.fetchById(context.auth, context.frame.sId);
    expect(frame?.useCaseMetadata?.activePublicationId).toBe(livePublicationId);
    expect(frame?.useCaseMetadata?.latestPublicationId).toBe(livePublicationId);
  });

  it("returns 403 for a Frame outside the token's conversation and attaches nothing", async () => {
    const context = await setup();
    const otherConversation = await ConversationFactory.create(context.auth, {
      agentConfigurationId: context.agentConfig.sId,
      messagesCreatedAt: [new Date()],
    });
    const otherFrame = await createTestConversationFrameFile(context.auth, {
      conversationId: otherConversation.sId,
      folderName: "Other",
    });
    const liveId = await publishBundleDirectly(
      context.auth,
      otherFrame,
      "export default function A() {}",
      "live"
    );
    const draftId = await publishBundleDirectly(
      context.auth,
      otherFrame,
      "export default function B() {}",
      "draft"
    );
    const generatedFilesBefore = await listGeneratedFiles(context);

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      otherFrame.sId,
      { publicationId: draftId }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "frame_not_in_conversation" },
    });
    const frame = await FileResource.fetchById(context.auth, otherFrame.sId);
    expect(frame?.useCaseMetadata?.activePublicationId).toBe(liveId);
    expect(frame?.useCaseMetadata?.latestPublicationId).toBe(draftId);
    expect(await listGeneratedFiles(context)).toEqual(generatedFilesBefore);
  });

  it("returns 404 for a Frame id that does not exist", async () => {
    const context = await setup();
    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      "fil_doesnotexist",
      { publicationId: "anything" }
    );

    expect(response.status).toBe(404);
  });

  it("returns 400 for a malformed Frame id", async () => {
    const context = await setup();

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      "not-a-file-id",
      { publicationId: "anything" }
    );

    expect(response.status).toBe(400);
  });

  it("returns 400 when publicationId is missing", async () => {
    const context = await setup();

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      context.frame.sId,
      {}
    );

    expect(response.status).toBe(400);
  });

  it("returns 403 for a token that is not a sandbox exec token", async () => {
    const context = await createSandboxFunctionInvocationTokenTestContext();

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      "fil_anything",
      { publicationId: "anything" }
    );

    // The frames sub-app's sandboxAuth rejects this token kind before the handler runs.
    expect(response.status).toBe(403);
  });

  it("returns 403 without the frames_v2 flag", async () => {
    const context = await createSandboxTokenTestContext();

    const response = await requestMakeLive(
      context.workspace.sId,
      context.token,
      "fil_anything",
      { publicationId: "anything" }
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { type: "feature_not_enabled" },
    });
  });
});
