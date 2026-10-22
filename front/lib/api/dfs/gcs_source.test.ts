// @vitest-environment node
import { gzipSync } from "node:zlib";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import { streamToBuffer } from "@app/lib/utils/streams";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { GcsSourceFactory } from "@app/tests/utils/GcsSourceFactory";
import { FakeGcsStorageServer } from "@app/tests/utils/mocks/gcs_storage";
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
const objectPath =
  "/b/test-private-bucket/o/w%2Fworkspace%2Fpods%2Fpod%2Ffiles%2Freport.txt";

describe("readGcsReplicationSource", () => {
  const server = new FakeGcsStorageServer();

  beforeAll(async () => {
    vi.stubEnv("STORAGE_EMULATOR_HOST", await server.start());
  });

  beforeEach(() => {
    server.reset();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it.each(["9007199254740993", "7"])(
    "reads current metadata and uses lossless preconditions for generation %s",
    async (generation) => {
      const metadata = GcsSourceFactory.metadata({
        generation,
        metageneration: "2",
      });
      server.responses.push(
        { statusCode: 200, body: metadata },
        { statusCode: 200, body: "new" }
      );

      const result = await readGcsReplicationSource(source);
      expect(result.isOk() && result.value.status).toBe("live");
      if (result.isOk() && result.value.status === "live") {
        expect(result.value.metadata).toEqual(metadata);
        const contentRes = await streamToBuffer(result.value.stream);
        expect(contentRes.isOk() && contentRes.value).toEqual(
          Buffer.from("new")
        );
      }
      const urls = server.requests.map(
        (request) => new URL(request.url, "http://storage.test")
      );
      expect(urls.map((url) => `${url.pathname}${url.search}`)).toEqual([
        objectPath,
        `${objectPath}?alt=media&ifGenerationMatch=${generation}&ifMetagenerationMatch=2`,
      ]);
    }
  );

  it("returns absent only for a live metadata 404", async () => {
    server.responses.push({ statusCode: 404 });
    const result = await readGcsReplicationSource(source);
    expect(result.isOk() && result.value).toEqual({ status: "absent" });
    expect(server.requests).toHaveLength(1);
  });

  it("reads an empty object to completion", async () => {
    server.responses.push(
      {
        statusCode: 200,
        body: GcsSourceFactory.metadata({ size: "0" }),
      },
      { statusCode: 200, body: "" }
    );
    const result = await readGcsReplicationSource(source);
    expect(result.isOk() && result.value.status).toBe("live");
    if (result.isOk() && result.value.status === "live") {
      const contentRes = await streamToBuffer(result.value.stream);
      expect(contentRes.isOk() && contentRes.value).toEqual(Buffer.alloc(0));
    }
  });

  it.each([404, 412])(
    "retries a change between metadata and content reads (%s)",
    async (statusCode) => {
      server.responses.push(
        {
          statusCode: 200,
          body: GcsSourceFactory.metadata(),
        },
        { statusCode }
      );
      const result = await readGcsReplicationSource(source);
      expect(result.isErr() && result.error.message).toBe(
        `GCS content read failed (${statusCode}).`
      );
      expect(server.requests).toHaveLength(2);
    }
  );

  it.each([403, 429, 500])(
    "returns a GCS failure for Temporal to retry (%s)",
    async (statusCode) => {
      server.responses.push({ statusCode });
      const result = await readGcsReplicationSource(source);
      expect(result.isErr()).toBe(true);
      expect(server.requests).toHaveLength(1);
    }
  );

  it("preserves compressed bytes as read through gcsfuse", async () => {
    const bytes = gzipSync("new");
    const metadata = GcsSourceFactory.metadata({
      contentEncoding: "gzip",
      size: String(bytes.length),
    });
    server.responses.push(
      { statusCode: 200, body: metadata },
      { statusCode: 200, body: bytes, headers: { "content-encoding": "gzip" } }
    );
    const result = await readGcsReplicationSource(source);
    expect(result.isOk() && result.value.status).toBe("live");
    if (result.isOk() && result.value.status === "live") {
      const contentRes = await streamToBuffer(result.value.stream);
      expect(contentRes.isOk() && contentRes.value).toEqual(bytes);
    }
    expect(server.requests[1].headers["accept-encoding"]).toBe("gzip");
  });

  it("does not fetch content from mismatched live metadata", async () => {
    server.responses.push({
      statusCode: 200,
      body: GcsSourceFactory.metadata({ bucket: "another-bucket" }),
    });
    const result = await readGcsReplicationSource(source);
    expect(result.isErr() && result.error.message).toBe(
      "GCS returned metadata for another object."
    );
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    { size: "4", crc32c: undefined, error: "length" },
    { size: "3", crc32c: "AAAAAA==", error: "CRC32C" },
  ])(
    "rejects bytes that fail $error validation",
    async ({ size, crc32c, error }) => {
      server.enqueueObject(source, "new", { size, crc32c });

      const sourceRes = await readGcsReplicationSource(source);
      expect(sourceRes.isOk() && sourceRes.value.status).toBe("live");
      if (sourceRes.isOk() && sourceRes.value.status === "live") {
        const contentRes = await streamToBuffer(sourceRes.value.stream);
        expect(contentRes.isErr() && contentRes.error).toContain(error);
      }
    }
  );

  it("does not read GCS when the importer has been cancelled", async () => {
    const result = await readGcsReplicationSource(source, {
      signal: AbortSignal.abort(),
    });
    expect(result.isErr() && result.error.name).toBe("AbortError");
    expect(server.requests).toHaveLength(0);
  });

  it("cancels an active content stream", async () => {
    server.responses.push(
      { statusCode: 200, body: GcsSourceFactory.metadata() },
      { statusCode: 200, body: "partial", hold: true }
    );
    const stop = new AbortController();
    const result = await readGcsReplicationSource(source, {
      signal: stop.signal,
    });
    expect(result.isOk() && result.value.status).toBe("live");
    if (result.isOk() && result.value.status === "live") {
      const read = streamToBuffer(result.value.stream);
      stop.abort();
      const contentRes = await read;
      expect(contentRes.isErr() && contentRes.error).toContain("aborted");
      expect(result.value.stream.destroyed).toBe(true);
    }
  });
});
