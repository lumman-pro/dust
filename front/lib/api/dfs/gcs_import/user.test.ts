// @vitest-environment node
import { getOrCreateUserFolder } from "@app/lib/api/dfs/folders";
import { GCS_SYNC_XATTR } from "@app/lib/api/dfs/gcs_import/file";
import { importGcsUserFile } from "@app/lib/api/dfs/gcs_import/user";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { DfsUserFolderResource } from "@app/lib/resources/dfs_user_folder_resource";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { GcsImportFactory } from "@app/tests/utils/GcsImportFactory";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { FakeGcsStorageServer } from "@app/tests/utils/mocks/gcs_storage";
import { DfsError } from "@app/types/dfs";
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

describe("importGcsUserFile", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it("imports user memory into the user folder and skips completed copies", async () => {
    const { auth, source, user } = await GcsImportFactory.user();
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    const content = Buffer.alloc(2 * 1024 * 1024, "a");
    server.enqueueObject(source, content);

    const importedRes = await importGcsUserFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    expect(dfs.paths()).toContain(`/users/${user.sId}/MEMORY.md`);
    const uri = formatDfsUri(importedRes.value);
    const bytesRes = await fs.readBuffer(uri);
    expect(bytesRes.isOk() && bytesRes.value.equals(content)).toBe(true);
    const writes = dfs.applyCalls.length;
    const grants = transport.calls.length;

    server.enqueueObject(source, content);
    const repeatedRes = await importGcsUserFile(auth, source, context);
    expect(repeatedRes).toEqual(importedRes);
    expect(dfs.applyCalls).toHaveLength(writes);
    expect(transport.calls).toHaveLength(grants);
  });

  it("updates metadata without rewriting bytes or changing unrelated xattrs and grants", async () => {
    const { auth, source } = await GcsImportFactory.user();
    const { context, dfs, fs, transport } = GcsImportFactory.context();
    server.enqueueObject(source, "report");
    const importedRes = await importGcsUserFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    await dfs.apply({
      operations: [
        {
          type: "update",
          objectId: importedRes.value,
          xattrs: [{ name: "other", value: Buffer.from("keep") }],
        },
      ],
    });
    const writes = dfs.applyCalls
      .flat()
      .filter((op) => op.type === "write").length;
    const grants = transport.calls.length;
    const updated = "2026-10-20T12:00:00Z";
    server.enqueueObject(source, "report", {
      metageneration: "2",
      contentType: "text/csv",
      updated,
    });

    const updatedRes = await importGcsUserFile(auth, source, context);
    const statRes = await fs.stat(formatDfsUri(importedRes.value), {
      includeMetadata: true,
    });

    expect(updatedRes.isOk() && updatedRes.value).toBe(importedRes.value);
    expect(
      dfs.applyCalls.flat().filter((op) => op.type === "write")
    ).toHaveLength(writes);
    expect(transport.calls).toHaveLength(grants);
    expect(statRes.isOk() && statRes.value?.attr.metadata?.mimeType).toBe(
      "text/csv"
    );
    expect(statRes.isOk() && statRes.value?.attr.mtimeMs).toBe(
      Date.parse(updated)
    );
    expect(
      statRes.isOk() && statRes.value?.attr.metadata?.xattrs.other
    ).toEqual(Buffer.from("keep"));
    const marker =
      statRes.isOk() && statRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR];
    expect(
      marker && JSON.parse(Buffer.from(marker).toString()).metageneration
    ).toBe("2");
  });

  it("uses a moved user folder and preserves literal relative paths", async () => {
    const { auth, source, user } = await GcsImportFactory.user();
    const { context, dfs, fs } = GcsImportFactory.context();
    const folderRes = await getOrCreateUserFolder(auth, context.folders, user);
    expect(folderRes.isOk()).toBe(true);
    if (folderRes.isErr()) {
      return;
    }

    const movedRes = await fs.move(
      formatDfsUri(dfs.rootId, { path: ["users", user.sId] }),
      formatDfsUri(dfs.rootId, { path: ["moved-user"] })
    );
    expect(movedRes.isOk()).toBe(true);
    const nested = GcsNotificationFactory.replicationSource({
      ...source,
      objectName: source.objectName.replace("MEMORY.md", "notes/100%2F.md"),
    });
    server.enqueueObject(nested, "note");

    const importedRes = await importGcsUserFile(auth, nested, context);
    const storedRes = await fs.stat(
      formatDfsUri(folderRes.value, { path: ["notes", "100%2F.md"] })
    );

    expect(importedRes.isOk()).toBe(true);
    expect(dfs.paths()).toContain("/moved-user/notes/100%2F.md");
    expect(storedRes.isOk() && storedRes.value?.attr.id).toBe(
      importedRes.isOk() && importedRes.value
    );
    expect(dfs.paths()).not.toContain(`/users/${user.sId}`);
  });

  it("rewrites bytes changed in DFS even if their size and GCS generation still match", async () => {
    const { auth, source } = await GcsImportFactory.user();
    const { context, dfs, fs } = GcsImportFactory.context();
    server.enqueueObject(source, "good");
    const importedRes = await importGcsUserFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }
    dfs.overwrite(importedRes.value, Buffer.from("oops"));
    server.enqueueObject(source, "good");

    const repairedRes = await importGcsUserFile(auth, source, context);
    const bytesRes = await fs.readBuffer(formatDfsUri(importedRes.value));

    expect(repairedRes.isOk() && repairedRes.value).toBe(importedRes.value);
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("good");
  });

  it("replaces and truncates a copy when the live generation changes", async () => {
    const { auth, source } = await GcsImportFactory.user();
    const { context, fs } = GcsImportFactory.context();
    server.enqueueObject(source, "original");
    const importedRes = await importGcsUserFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    server.enqueueObject(source, "new", { generation: "7" });
    const updatedRes = await importGcsUserFile(auth, source, context);
    const bytesRes = await fs.readBuffer(formatDfsUri(importedRes.value));

    expect(updatedRes.isOk() && updatedRes.value).toBe(importedRes.value);
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("new");
  });

  it("clears the completion marker when a replacement fails checksum validation", async () => {
    const { auth, source } = await GcsImportFactory.user();
    const { context, fs } = GcsImportFactory.context();
    server.enqueueObject(source, "original");
    const importedRes = await importGcsUserFile(auth, source, context);
    expect(importedRes.isOk()).toBe(true);
    if (importedRes.isErr()) {
      return;
    }

    server.enqueueObject(source, "corrupt", {
      generation: "7",
      crc32c: "AAAAAA==",
    });
    const failedRes = await importGcsUserFile(auth, source, context);
    const statRes = await fs.stat(formatDfsUri(importedRes.value), {
      includeMetadata: true,
    });

    expect(failedRes.isErr()).toBe(true);
    expect(
      statRes.isOk() && statRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
    ).toBeUndefined();
  });

  it("leaves a failed copy incomplete and reuses its file on retry", async () => {
    const { auth, source, user } = await GcsImportFactory.user();
    let failWrite = true;
    const dfs = new InMemoryDfs({
      failApply: (i) =>
        failWrite && dfs.applyCalls[i].some((op) => op.type === "write")
          ? new DfsError("unavailable")
          : null,
    });
    const { context, fs } = GcsImportFactory.context(dfs);
    server.enqueueObject(source, "report");

    const failedRes = await importGcsUserFile(auth, source, context);
    expect(failedRes.isErr()).toBe(true);
    const stored = await DfsUserFolderResource.fetchByUser(auth, user);
    const uri = formatDfsUri(stored?.dfsObjectId ?? "", {
      path: ["MEMORY.md"],
    });
    const partialRes = await fs.stat(uri, { includeMetadata: true });
    expect(partialRes.isOk() && partialRes.value).toBeTruthy();
    expect(
      partialRes.isOk() &&
        partialRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
    ).toBeUndefined();
    failWrite = false;
    server.enqueueObject(source, "report");

    const retriedRes = await importGcsUserFile(auth, source, context);
    expect(retriedRes.isOk() && retriedRes.value).toBe(
      partialRes.isOk() && partialRes.value?.attr.id
    );
    const bytesRes = await fs.readBuffer(uri);
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("report");
  });

  it("refuses an unrelated file at the destination", async () => {
    const { auth, source, user } = await GcsImportFactory.user();
    const { context, dfs, fs } = GcsImportFactory.context();
    const folderRes = await getOrCreateUserFolder(auth, context.folders, user);
    expect(folderRes.isOk()).toBe(true);
    if (folderRes.isErr()) {
      return;
    }
    const fileId = dfs.createFile(folderRes.value, "MEMORY.md", "original");
    server.enqueueObject(source, "replacement");

    const importedRes = await importGcsUserFile(auth, source, context);
    const bytesRes = await fs.readBuffer(formatDfsUri(fileId));

    expect(importedRes.isErr()).toBe(true);
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("original");
  });

  it("rejects a source from another workspace before reading GCS or writing DFS", async () => {
    const { auth, user } = await GcsImportFactory.user();
    const { context, dfs } = GcsImportFactory.context();

    const importedRes = await importGcsUserFile(
      auth,
      GcsNotificationFactory.replicationSource({
        workspaceId: "another-workspace",
        objectName: `w/another-workspace/users/${user.sId}/files/MEMORY.md`,
      }),
      context
    );

    expect(importedRes.isErr()).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
  });

  it("does not create a file or report completion for an absent source", async () => {
    const { auth, source } = await GcsImportFactory.user();
    const { context, dfs } = GcsImportFactory.context();
    server.responses.push({ statusCode: 404 });

    const importedRes = await importGcsUserFile(auth, source, context);

    expect(importedRes.isErr()).toBe(true);
    expect(dfs.applyCalls).toHaveLength(0);
  });

  it("rejects another user's object under the same workspace prefix", async () => {
    const { auth, workspace } = await GcsImportFactory.user();
    const other = await GcsImportFactory.user();
    const { context, dfs } = GcsImportFactory.context();
    const source = GcsNotificationFactory.replicationSource({
      workspaceId: workspace.sId,
      objectName: `w/${workspace.sId}/users/${other.user.sId}/files/MEMORY.md`,
    });

    const importedRes = await importGcsUserFile(auth, source, context);

    expect(importedRes.isErr()).toBe(true);
    expect(server.requests).toHaveLength(0);
    expect(dfs.applyCalls).toHaveLength(0);
  });
});
