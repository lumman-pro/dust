// @vitest-environment node
import { getOrCreatePodFolder } from "@app/lib/api/dfs/folders";
import { importGcsPodFile } from "@app/lib/api/dfs/gcs_import/pod";
import { Authenticator } from "@app/lib/auth";
import { formatDfsUri } from "@app/lib/dfs/uri";
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

describe("importGcsPodFile", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it("imports nested files under the pod's name and skips completed copies", async () => {
    const { auth, source, pod, user } = await GcsImportFactory.pod();
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");

    const importedRes = await importGcsPodFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    expect(dfs.paths()).toContain(
      `/users/${user.sId}/pods/${pod.name}/nested/report.txt`
    );
    const stored = await SpaceResource.fetchById(auth, pod.sId);
    const fileRes = await fs.stat(
      formatDfsUri(stored?.dfsObjectId ?? "", {
        path: ["nested", "report.txt"],
      })
    );
    expect(fileRes.isOk() && fileRes.value?.attr.id).toBe(importedRes.value);
    const bytesRes = await fs.readBuffer(formatDfsUri(importedRes.value));
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("report");

    const writes = dfs.applyCalls.length;
    const grants = transport.calls.length;
    server.enqueueObject(source, "report");
    const repeatedRes = await importGcsPodFile(auth, source, context);

    expect(repeatedRes).toEqual(importedRes);
    expect(dfs.applyCalls).toHaveLength(writes);
    expect(transport.calls).toHaveLength(grants);
  });

  it("uses a moved pod folder and preserves literal relative paths", async () => {
    const { auth, source, pod, user } = await GcsImportFactory.pod();
    const { context, dfs, fs } = GcsImportFactory.context();
    const folderRes = await getOrCreatePodFolder(auth, context.folders, pod);
    expect(folderRes.isOk()).toBe(true);
    if (folderRes.isErr()) {
      return;
    }

    const movedRes = await fs.move(
      formatDfsUri(dfs.rootId, { path: ["users", user.sId, "pods", pod.name] }),
      formatDfsUri(dfs.rootId, { path: ["moved-pod"] })
    );
    expect(movedRes.isOk()).toBe(true);
    const nested = GcsNotificationFactory.replicationSource({
      ...source,
      objectName: source.objectName.replace("report.txt", "100%2F.md"),
    });
    server.enqueueObject(nested, "note");

    const importedRes = await importGcsPodFile(auth, nested, context);

    expect(importedRes.isOk()).toBe(true);
    expect(dfs.paths()).toContain("/moved-pod/nested/100%2F.md");
    expect(dfs.paths()).not.toContain(`/users/${user.sId}/pods/${pod.name}`);
  });

  it("rejects a source from another workspace before reading GCS or writing DFS", async () => {
    const { auth } = await GcsImportFactory.user();
    const { source } = await GcsImportFactory.pod();
    const { context, dfs, transport } = GcsImportFactory.context();

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr()).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a pod from another workspace even under the current workspace's prefix", async () => {
    const { auth, workspace } = await GcsImportFactory.user();
    const { pod } = await GcsImportFactory.pod();
    const { context, dfs, transport } = GcsImportFactory.context();
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/${pod.sId}/files/report.txt`,
    });

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr() && importedRes.error.message).toBe(
      "Source pod not found."
    );
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a pod reader before reading GCS or writing DFS", async () => {
    const { workspace, pod, globalGroup, source } =
      await GcsImportFactory.pod();
    await SpaceFactory.attachGroup(pod, globalGroup, "project_viewer");
    const auth = await Authenticator.internalUserForWorkspace(workspace.sId);
    const { context, dfs, transport } = GcsImportFactory.context();
    expect(auth.can("read", pod)).toBe(true);

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr() && importedRes.error.message).toBe(
      "Cannot import files into this pod."
    );
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("rejects a regular space used as a pod", async () => {
    const { auth, workspace } = await GcsImportFactory.user();
    const space = await SpaceFactory.regular(workspace);
    const { context, dfs } = GcsImportFactory.context();
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/pods/${space.sId}/files/report.txt`,
    });

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr() && importedRes.error.message).toBe(
      "Source pod not found."
    );
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
  });

  it("fails when a new pod folder has no active editor to own it", async () => {
    const { auth, source } = await GcsImportFactory.pod({
      withActiveEditor: false,
    });
    const { context, dfs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr() && importedRes.error.message).toContain(
      "has no editor"
    );
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("does not create a folder or report completion for an absent source", async () => {
    const { auth, source, pod } = await GcsImportFactory.pod();
    const { context, dfs, transport } = GcsImportFactory.context();
    server.responses.push({ statusCode: 404 });

    const importedRes = await importGcsPodFile(auth, source, context);

    expect(importedRes.isErr() && importedRes.error.message).toContain(
      "deletion is not implemented"
    );
    const stored = await SpaceResource.fetchById(auth, pod.sId);
    expect(stored?.dfsObjectId).toBeNull();
    expect(dfs.applyCalls).toHaveLength(0);
    expect(transport.calls).toHaveLength(0);
  });
});
