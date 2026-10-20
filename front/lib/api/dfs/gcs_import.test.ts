// @vitest-environment node
import { gzipSync } from "node:zlib";
import {
  GCS_CONTENT_ENCODING_XATTR,
  GCS_SYNC_XATTR,
  importGcsSourceToDfsFile,
} from "@app/lib/api/dfs/gcs_import";
import { DfsFileSystem } from "@app/lib/dfs/file_system";
import { formatDfsUri } from "@app/lib/dfs/uri";
import { InMemoryDfs } from "@app/tests/utils/dfs/InMemoryDfs";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { FakeGcsStorageServer } from "@app/tests/utils/mocks/gcs_storage";
import { DfsError } from "@app/types/dfs";
import { Err } from "@app/types/shared/result";
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

const source = GcsNotificationFactory.replicationSource();
const metadata = GcsNotificationFactory.notification().metadata;
const marker = Buffer.from(
  JSON.stringify({
    bucket: source.bucket,
    objectName: source.objectName,
    generation: metadata.generation,
    metageneration: metadata.metageneration,
  })
);

describe("importGcsSourceToDfsFile", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => server.reset());

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it("imports multiple chunks under the same ID and preserves unrelated xattrs", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "", undefined, {
      "front.other": Buffer.from("keep"),
    });
    const content = Buffer.alloc(5 * 1024 * 1024, "a");
    server.responses.push(
      { statusCode: 200, body: { ...metadata, size: String(content.length) } },
      { statusCode: 200, body: content }
    );

    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isOk()).toBe(true);
    const fs = new DfsFileSystem(dfs);
    const bytesRes = await fs.readBuffer(formatDfsUri(objectId));
    expect(bytesRes.isOk() && bytesRes.value).toEqual(content);
    const statRes = await fs.stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(statRes.isOk() && statRes.value?.attr.metadata).toMatchObject({
      mimeType: "text/plain",
      xattrs: { [GCS_SYNC_XATTR]: marker, "front.other": Buffer.from("keep") },
    });
    const operations = dfs.applyCalls.flat();
    expect(operations.filter((op) => op.type === "write")).toHaveLength(2);
    expect(operations.at(-1)).toMatchObject({
      type: "update",
      xattrs: expect.arrayContaining([{ name: GCS_SYNC_XATTR, value: marker }]),
    });
  });

  it("skips a completed generation and metageneration without DFS mutations", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(
      dfs.rootId,
      "report.txt",
      "new",
      "text/plain",
      {
        [GCS_SYNC_XATTR]: marker,
      }
    );
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, hold: true }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isOk()).toBe(true);
    expect(dfs.applyCalls).toEqual([]);
  });

  it("updates metadata without rewriting complete bytes or unrelated xattrs", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(
      dfs.rootId,
      "report.txt",
      "new",
      "text/plain",
      {
        [GCS_SYNC_XATTR]: marker,
        [GCS_CONTENT_ENCODING_XATTR]: Buffer.from("gzip"),
        "front.other": Buffer.from("keep"),
      }
    );
    server.responses.push(
      {
        statusCode: 200,
        body: { ...metadata, metageneration: "2", contentType: "text/csv" },
      },
      { statusCode: 200, hold: true }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isOk()).toBe(true);
    expect(dfs.applyCalls.flat().some((op) => op.type === "write")).toBe(false);
    const fs = new DfsFileSystem(dfs);
    const statRes = await fs.stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(statRes.isOk() && statRes.value?.attr.metadata).toMatchObject({
      mimeType: "text/csv",
      xattrs: { "front.other": Buffer.from("keep") },
    });
    if (statRes.isOk()) {
      const xattrs = statRes.value?.attr.metadata?.xattrs;
      expect(xattrs?.[GCS_CONTENT_ENCODING_XATTR]).toBeUndefined();
      expect(
        JSON.parse(Buffer.from(xattrs?.[GCS_SYNC_XATTR] ?? []).toString())
      ).toEqual({
        bucket: source.bucket,
        objectName: source.objectName,
        generation: metadata.generation,
        metageneration: "2",
      });
    }
    const bytesRes = await fs.readBuffer(formatDfsUri(objectId));
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("new");
  });

  it.each(["", "new"])(
    "replaces an older copy and truncates its tail (%j)",
    async (content) => {
      const dfs = new InMemoryDfs();
      const objectId = dfs.createFile(
        dfs.rootId,
        "report.txt",
        "old trailing bytes",
        undefined,
        {
          [GCS_SYNC_XATTR]: marker,
        }
      );
      // Generations are compared for equality, not numerically ordered.
      server.responses.push(
        {
          statusCode: 200,
          body: { ...metadata, generation: "7", size: String(content.length) },
        },
        { statusCode: 200, body: content }
      );
      const result = await importGcsSourceToDfsFile(source, {
        client: dfs,
        target: { objectId, parentId: dfs.rootId },
        signal: new AbortController().signal,
      });
      expect(result.isOk()).toBe(true);
      const bytesRes = await new DfsFileSystem(dfs).readBuffer(
        formatDfsUri(objectId)
      );
      expect(bytesRes.isOk() && bytesRes.value.toString()).toBe(content);
      expect(dfs.paths()).toEqual(["/report.txt"]);
    }
  );

  it("leaves the marker absent after a short transfer and repairs it on retry", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "", undefined, {
      [GCS_SYNC_XATTR]: marker,
    });
    const options = {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    };
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, body: "n" }
    );
    expect((await importGcsSourceToDfsFile(source, options)).isErr()).toBe(
      true
    );
    const fs = new DfsFileSystem(dfs);
    const partialRes = await fs.stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(
      partialRes.isOk() &&
        partialRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
    ).toBeUndefined();

    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, body: "new" }
    );
    expect((await importGcsSourceToDfsFile(source, options)).isOk()).toBe(true);
    const bytesRes = await fs.readBuffer(formatDfsUri(objectId));
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("new");
  });

  it("does not write a completion marker after an attribute operation fails", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "");
    server.responses.push(
      { statusCode: 200, body: { ...metadata, contentType: "invalid" } },
      { statusCode: 200, body: "new" }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isErr()).toBe(true);
    const statRes = await new DfsFileSystem(dfs).stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(
      statRes.isOk() && statRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
    ).toBeUndefined();
  });

  it("stops before copying when clearing the previous marker fails", async () => {
    const dfs = new InMemoryDfs({
      failApply: () => new DfsError("unavailable"),
    });
    const objectId = dfs.createFile(
      dfs.rootId,
      "report.txt",
      "old",
      undefined,
      { [GCS_SYNC_XATTR]: marker }
    );
    server.responses.push(
      { statusCode: 200, body: { ...metadata, generation: "7" } },
      { statusCode: 200, body: "new" }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isErr()).toBe(true);
    expect(dfs.applyCalls).toHaveLength(1);
    const bytesRes = await new DfsFileSystem(dfs).readBuffer(
      formatDfsUri(objectId)
    );
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("old");
  });

  it("stops further writes on cancellation between chunks", async () => {
    const controller = new AbortController();
    const dfs = new InMemoryDfs({
      beforeApply: (index) => {
        if (index === 1) {
          controller.abort();
        }
      },
    });
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "");
    const content = Buffer.alloc(5 * 1024 * 1024, "a");
    server.responses.push(
      { statusCode: 200, body: { ...metadata, size: String(content.length) } },
      { statusCode: 200, body: content }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: controller.signal,
    });
    expect(result.isErr()).toBe(true);
    expect(dfs.applyCalls).toHaveLength(2);
    const statRes = await new DfsFileSystem(dfs).stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(
      statRes.isOk() && statRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
    ).toBeUndefined();
  });

  it("deletes only on a metadata 404 and accepts a repeated deletion", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(
      dfs.rootId,
      "report.txt",
      "new",
      undefined,
      { [GCS_SYNC_XATTR]: marker }
    );
    const options = {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    };
    server.responses.push({ statusCode: 404 }, { statusCode: 404 });
    expect((await importGcsSourceToDfsFile(source, options)).isOk()).toBe(true);
    expect((await importGcsSourceToDfsFile(source, options)).isOk()).toBe(true);
    expect(dfs.paths()).toEqual([]);
    expect(dfs.applyCalls).toHaveLength(1);
  });

  it.each([404, 412])(
    "keeps the replica when the media read fails with %s",
    async (statusCode) => {
      const dfs = new InMemoryDfs();
      const objectId = dfs.createFile(dfs.rootId, "report.txt", "old");
      server.responses.push(
        { statusCode: 200, body: metadata },
        { statusCode }
      );
      const result = await importGcsSourceToDfsFile(source, {
        client: dfs,
        target: { objectId, parentId: dfs.rootId },
        signal: new AbortController().signal,
      });
      expect(result.isErr()).toBe(true);
      expect(dfs.applyCalls).toEqual([]);
      expect(dfs.paths()).toEqual(["/report.txt"]);
    }
  );

  it("refuses a target marked for another source", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(
      dfs.rootId,
      "report.txt",
      "old",
      undefined,
      {
        [GCS_SYNC_XATTR]: Buffer.from(
          JSON.stringify({ ...metadata, objectName: "another-source" })
        ),
      }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isErr()).toBe(true);
    expect(dfs.applyCalls).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it.each(["new", "bad"])(
    "validates GCS CRC32C before completing a copy (%s)",
    async (content) => {
      const dfs = new InMemoryDfs();
      const objectId = dfs.createFile(dfs.rootId, "report.txt", "");
      server.responses.push(
        { statusCode: 200, body: { ...metadata, crc32c: "10P8Lg==" } },
        { statusCode: 200, body: content }
      );
      const result = await importGcsSourceToDfsFile(source, {
        client: dfs,
        target: { objectId, parentId: dfs.rootId },
        signal: new AbortController().signal,
      });
      expect(result.isOk()).toBe(content === "new");
      const statRes = await new DfsFileSystem(dfs).stat(
        formatDfsUri(objectId),
        { includeMetadata: true }
      );
      expect(
        statRes.isOk() && statRes.value?.attr.metadata?.xattrs[GCS_SYNC_XATTR]
      ).toEqual(content === "new" ? marker : undefined);
    }
  );

  it("keeps a committed completion marker when its response is lost and skips on retry", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "old");
    const apply = dfs.apply.bind(dfs);
    vi.spyOn(dfs, "apply").mockImplementation(async (request) => {
      const result = await apply(request);
      const completes = request.operations.some(
        (op) =>
          op.type === "update" &&
          op.xattrs?.some(
            (xattr) => xattr.name === GCS_SYNC_XATTR && xattr.value
          )
      );
      return completes ? new Err(new DfsError("unavailable")) : result;
    });
    const options = {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    };
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, body: "new" }
    );
    expect((await importGcsSourceToDfsFile(source, options)).isErr()).toBe(
      true
    );
    const calls = dfs.applyCalls.length;
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, hold: true }
    );
    expect((await importGcsSourceToDfsFile(source, options)).isOk()).toBe(true);
    expect(dfs.applyCalls).toHaveLength(calls);
    const bytesRes = await new DfsFileSystem(dfs).readBuffer(
      formatDfsUri(objectId)
    );
    expect(bytesRes.isOk() && bytesRes.value.toString()).toBe("new");
  });

  it("rejects a source whose prefix belongs to another workspace", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "old");
    const result = await importGcsSourceToDfsFile(
      { ...source, workspaceId: "another-workspace" },
      {
        client: dfs,
        target: { objectId, parentId: dfs.rootId },
        signal: new AbortController().signal,
      }
    );
    expect(result.isErr()).toBe(true);
    expect(dfs.applyCalls).toEqual([]);
    expect(server.requests).toEqual([]);
  });

  it("does not recreate a missing mapped file at another ID", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "old");
    await new DfsFileSystem(dfs).remove(
      formatDfsUri(dfs.rootId, { path: ["report.txt"] })
    );
    const calls = dfs.applyCalls.length;
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, hold: true }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isErr()).toBe(true);
    expect(dfs.paths()).toEqual([]);
    expect(dfs.applyCalls).toHaveLength(calls);
  });

  it("preserves gzip bytes and records their encoding", async () => {
    const dfs = new InMemoryDfs();
    const objectId = dfs.createFile(dfs.rootId, "report.txt", "");
    const content = gzipSync("new");
    server.responses.push(
      {
        statusCode: 200,
        body: {
          ...metadata,
          size: String(content.length),
          contentEncoding: "gzip",
        },
      },
      {
        statusCode: 200,
        body: content,
        headers: { "content-encoding": "gzip" },
      }
    );
    const result = await importGcsSourceToDfsFile(source, {
      client: dfs,
      target: { objectId, parentId: dfs.rootId },
      signal: new AbortController().signal,
    });
    expect(result.isOk()).toBe(true);
    const fs = new DfsFileSystem(dfs);
    const bytesRes = await fs.readBuffer(formatDfsUri(objectId));
    expect(bytesRes.isOk() && bytesRes.value).toEqual(content);
    const statRes = await fs.stat(formatDfsUri(objectId), {
      includeMetadata: true,
    });
    expect(
      statRes.isOk() &&
        statRes.value?.attr.metadata?.xattrs[GCS_CONTENT_ENCODING_XATTR]
    ).toEqual(Buffer.from("gzip"));
  });
});
