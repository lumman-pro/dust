import { gzipSync } from "node:zlib";
// @vitest-environment node
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { GoogleAuth } from "google-auth-library";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDispatcher = getGlobalDispatcher();
const objectPath =
  "/storage/v1/b/test-private-bucket/o/w%2Fworkspace%2Fpods%2Fpod%2Ffiles%2Freport.txt";
const mediaPath = `${objectPath}?alt=media&ifGenerationMatch=9007199254740993&ifMetagenerationMatch=1`;

describe("readGcsReplicationSource", () => {
  let agent: MockAgent;

  beforeEach(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
    vi.spyOn(GoogleAuth.prototype, "getAccessToken").mockResolvedValue(
      "test-token"
    );
  });

  afterEach(async () => {
    setGlobalDispatcher(originalDispatcher);
    await agent.close();
    vi.restoreAllMocks();
  });

  it.each(["OBJECT_FINALIZE", "OBJECT_METADATA_UPDATE"] as const)(
    "%s reads the live object with lossless preconditions and no generation selector",
    async (eventType) => {
      agent
        .get("https://storage.googleapis.com")
        .intercept({
          path: mediaPath,
          headers: { authorization: "Bearer test-token" },
        })
        .reply(200, "new");

      const result = await readGcsReplicationSource(
        GcsNotificationFactory.notification({ eventType })
      );
      expect(result.isOk() && result.value.status).toBe("live");
      if (result.isOk() && result.value.status === "live") {
        expect(await result.value.stream.toArray()).toEqual([
          Buffer.from("new"),
        ]);
        expect(result.value.metadata.generation).toBe("9007199254740993");
      }
      agent.assertNoPendingInterceptors();
    }
  );

  it.each([
    { code: 412, status: "superseded" },
    { code: 404, status: "absent" },
  ])(
    "maps a conditional live read's $code to $status",
    async ({ code, status }) => {
      agent
        .get("https://storage.googleapis.com")
        .intercept({ path: mediaPath })
        .reply(code);
      const result = await readGcsReplicationSource(
        GcsNotificationFactory.notification()
      );
      expect(result.isOk() && result.value).toEqual({ status });
    }
  );

  it.each(["OBJECT_DELETE", "OBJECT_ARCHIVE"] as const)(
    "%s reads the current replacement even when its generation is numerically smaller",
    async (eventType) => {
      const metadata = GcsNotificationFactory.notification({
        metadata: { generation: "7", metageneration: "2" },
      }).metadata;
      const pool = agent.get("https://storage.googleapis.com");
      pool.intercept({ path: objectPath }).reply(200, metadata);
      pool
        .intercept({
          path: `${objectPath}?alt=media&ifGenerationMatch=7&ifMetagenerationMatch=2`,
        })
        .reply(200, "new");

      const result = await readGcsReplicationSource(
        GcsNotificationFactory.notification({ eventType })
      );
      expect(result.isOk() && result.value.status).toBe("live");
      if (result.isOk() && result.value.status === "live") {
        expect(result.value.metadata).toEqual(metadata);
        expect(await result.value.stream.toArray()).toEqual([
          Buffer.from("new"),
        ]);
      }
      agent.assertNoPendingInterceptors();
    }
  );

  it("returns absent for an authoritative live metadata 404", async () => {
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: objectPath })
      .reply(404);
    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification({ eventType: "OBJECT_DELETE" })
    );
    expect(result.isOk() && result.value).toEqual({ status: "absent" });
  });

  it.each([404, 412])(
    "keeps a change between metadata and media reads retryable (%s)",
    async (code) => {
      const pool = agent.get("https://storage.googleapis.com");
      pool
        .intercept({ path: objectPath })
        .reply(200, GcsNotificationFactory.notification().metadata);
      pool.intercept({ path: mediaPath }).reply(code);

      const result = await readGcsReplicationSource(
        GcsNotificationFactory.notification({ eventType: "OBJECT_DELETE" })
      );
      expect(result.isErr()).toBe(true);
      agent.assertNoPendingInterceptors();
    }
  );

  it.each([403, 429, 500])(
    "does not treat a GCS failure as deletion (%s)",
    async (code) => {
      agent
        .get("https://storage.googleapis.com")
        .intercept({ path: mediaPath })
        .reply(code);
      const result = await readGcsReplicationSource(
        GcsNotificationFactory.notification()
      );
      expect(result.isErr()).toBe(true);
    }
  );

  it("preserves compressed bytes as read through gcsfuse", async () => {
    const bytes = gzipSync("new");
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: mediaPath, headers: { "accept-encoding": "gzip" } })
      .reply(200, bytes, { headers: { "content-encoding": "gzip" } });

    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification({
        metadata: { contentEncoding: "gzip", size: String(bytes.length) },
      })
    );
    expect(result.isOk() && result.value.status).toBe("live");
    if (result.isOk() && result.value.status === "live") {
      expect(Buffer.concat(await result.value.stream.toArray())).toEqual(bytes);
    }
  });

  it("does not fetch content from mismatched live metadata", async () => {
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: objectPath })
      .reply(
        200,
        GcsNotificationFactory.notification({
          metadata: { bucket: "another-bucket" },
        }).metadata
      );
    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification({ eventType: "OBJECT_ARCHIVE" })
    );
    expect(result.isErr() && result.error.message).toBe(
      "GCS returned metadata for another object."
    );
    agent.assertNoPendingInterceptors();
  });

  it("keeps transport failures retryable", async () => {
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: mediaPath })
      .replyWithError(new Error("connection reset"));

    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification()
    );
    expect(result.isErr() && result.error.message).toBe("connection reset");
  });

  it("fails without reading GCS when credentials are unavailable", async () => {
    vi.mocked(GoogleAuth.prototype.getAccessToken).mockResolvedValue(null);

    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification()
    );
    expect(result.isErr() && result.error.message).toBe(
      "GCP auth returned no access token."
    );
  });

  it("does not read content when the importer has been cancelled", async () => {
    const stop = new AbortController();
    stop.abort();
    const result = await readGcsReplicationSource(
      GcsNotificationFactory.notification(),
      { signal: stop.signal }
    );
    expect(result.isErr() && result.error.name).toBe("AbortError");
  });
});
