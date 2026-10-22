// @vitest-environment node
import { importGcsPodConversationFile } from "@app/lib/api/dfs/gcs_import/pod_conversation";
import { Authenticator } from "@app/lib/auth";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { ConversationResource } from "@app/lib/resources/conversation_resource";
import { SpaceResource } from "@app/lib/resources/space_resource";
import { GcsImportFactory } from "@app/tests/utils/GcsImportFactory";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { FakeGcsStorageServer } from "@app/tests/utils/mocks/gcs_storage";
import { SpaceFactory } from "@app/tests/utils/SpaceFactory";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.unmock("@app/lib/file_storage");

describe("importGcsPodConversationFile", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it("imports under the pod's conversation folder and skips completed copies", async () => {
    const { auth, source, conversation, pod, user } =
      await GcsImportFactory.podConversation();
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    const folderMkdir = vi.spyOn(context.folders.fs, "mkdir");
    server.enqueueObject(source, "report");

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    expect(dfs.paths()).toContain(
      `/users/${user.sId}/pods/${pod.name}/.conversations/conv-${conversation.sId}/nested/report.txt`
    );
    const stored = await ConversationResource.fetchById(auth, conversation.sId);
    const fileRes = await fs.stat(
      formatDfsUri(stored?.dfsObjectId ?? "", {
        path: ["nested", "report.txt"],
      })
    );
    expect(fileRes.isOk() && fileRes.value?.attr.id).toBe(importedRes.value);
    const bytesRes = await fs.readBuffer(formatDfsUri(importedRes.value));
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("report");

    // The folder-only session creates the user and pod, never the conversation directories.
    expect(folderMkdir.mock.calls).toHaveLength(2);
    expect(
      folderMkdir.mock.calls.every(([uri]) => !uri.includes(".conversations"))
    ).toBe(true);
    expect(transport.calls).toHaveLength(2);
    const storedPod = await SpaceResource.fetchById(auth, pod.sId);
    expect(transport.calls.at(-1)?.request.objectId).toEqual({
      value: Buffer.from(storedPod?.dfsObjectId ?? "", "hex"),
    });

    const writes = dfs.applyCalls.length;
    server.enqueueObject(source, "report");
    const repeatedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(repeatedRes).toEqual(importedRes);
    expect(dfs.applyCalls).toHaveLength(writes);
    expect(transport.calls).toHaveLength(2);
  });

  it("reuses a moved conversation folder and preserves literal relative paths", async () => {
    const { auth, source, conversation, pod, user } =
      await GcsImportFactory.podConversation();
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");
    const firstRes = await importGcsPodConversationFile(auth, source, context);
    expect(firstRes.isOk()).toBe(true);

    const movedRes = await fs.move(
      formatDfsUri(dfs.rootId, {
        path: [
          "users",
          user.sId,
          "pods",
          pod.name,
          ".conversations",
          `conv-${conversation.sId}`,
        ],
      }),
      formatDfsUri(dfs.rootId, { path: ["moved-conversation"] })
    );
    expect(movedRes.isOk()).toBe(true);
    const nested = GcsNotificationFactory.replicationSource({
      ...source,
      objectName: source.objectName.replace("report.txt", "100%2F.md"),
    });
    const grants = transport.calls.length;
    server.enqueueObject(nested, "note");

    const importedRes = await importGcsPodConversationFile(
      auth,
      nested,
      context
    );

    expect(importedRes.isOk()).toBe(true);
    expect(dfs.paths()).toContain("/moved-conversation/nested/100%2F.md");
    expect(dfs.paths()).not.toContain(
      `/users/${user.sId}/pods/${pod.name}/.conversations/conv-${conversation.sId}`
    );
    expect(transport.calls).toHaveLength(grants);
  });

  it("accepts a pod reader without requiring participation", async () => {
    const { workspace, pod, globalGroup, source, conversation } =
      await GcsImportFactory.podConversation({ depth: 1 });
    await SpaceFactory.attachGroup(pod, globalGroup, "project_viewer");
    const auth = await Authenticator.internalUserForWorkspace(workspace.sId);
    const { context } = GcsImportFactory.context();
    expect(auth.can("read", pod)).toBe(true);
    expect(auth.can("write", pod)).toBe(false);
    expect(await conversation.listParticipantsForConversation()).toEqual([]);
    server.enqueueObject(source, "report");

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(importedRes.isOk()).toBe(true);
  });

  it("rejects an unreadable pod before reading GCS or writing DFS", async () => {
    const { workspace, source } = await GcsImportFactory.podConversation();
    const auth = await Authenticator.internalUserForWorkspace(workspace.sId);
    const { context, dfs, transport } = GcsImportFactory.context();

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(importedRes.isErr()).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects standalone conversations before reading GCS or writing DFS", async () => {
    const { auth, source, conversation } =
      await GcsImportFactory.podConversation();
    await conversation.updateSpaceId(auth, null);
    const { context, dfs, transport } = GcsImportFactory.context();

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(importedRes.isErr() && importedRes.error.message).toBe(
      "Source pod conversation not found."
    );
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it.each([false, true])(
    "rejects another workspace's conversation (rewritten prefix: %s)",
    async (rewritePrefix) => {
      const { auth, workspace } = await GcsImportFactory.user();
      const { source, conversation } = await GcsImportFactory.podConversation();
      const { context, dfs, transport } = GcsImportFactory.context();
      const foreign = rewritePrefix
        ? GcsNotificationFactory.replicationSource({
            workspaceId: workspace.sId,
            objectName: `w/${workspace.sId}/conversations/${conversation.sId}/files/report.txt`,
          })
        : source;

      const importedRes = await importGcsPodConversationFile(
        auth,
        foreign,
        context
      );

      expect(importedRes.isErr()).toBe(true);
      expect(server.requests).toHaveLength(0);
      expect(dfs.applyCalls).toHaveLength(0);
      expect(transport.calls).toHaveLength(0);
    }
  );

  it("fails when a new pod folder has no active editor", async () => {
    const { auth, source } = await GcsImportFactory.podConversation({
      withActiveEditor: false,
    });
    const { context, dfs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(importedRes.isErr() && importedRes.error.message).toContain(
      "has no editor"
    );
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("does not create folders for an absent source", async () => {
    const { auth, source, conversation, pod } =
      await GcsImportFactory.podConversation();
    const { context, dfs, transport } = GcsImportFactory.context();
    server.responses.push({ statusCode: 404 });

    const importedRes = await importGcsPodConversationFile(
      auth,
      source,
      context
    );

    expect(importedRes.isErr() && importedRes.error.message).toContain(
      "deletion is not implemented"
    );
    const stored = await ConversationResource.fetchById(auth, conversation.sId);
    const storedPod = await SpaceResource.fetchById(auth, pod.sId);
    expect(stored?.dfsObjectId).toBeNull();
    expect(storedPod?.dfsObjectId).toBeNull();
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});
