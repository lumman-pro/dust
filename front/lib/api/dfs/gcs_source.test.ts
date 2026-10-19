// @vitest-environment node
import { gzipSync } from "node:zlib";
import { readGcsReplicationSource } from "@app/lib/api/dfs/gcs_source";
import { GcsNotificationFactory } from "@app/tests/utils/GcsNotificationFactory";
import { GoogleAuth } from "google-auth-library";
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDispatcher = getGlobalDispatcher();
const source = GcsNotificationFactory.replicationSource();
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

  it.each(["9007199254740993", "7"])(
    "reads current metadata and uses lossless preconditions for generation %s",
    async (generation) => {
      const metadata = GcsNotificationFactory.notification({
        metadata: { generation, metageneration: "2" },
      }).metadata;
      const pool = agent.get("https://storage.googleapis.com");
      pool.intercept({ path: objectPath }).reply(200, metadata);
      pool
        .intercept({
          path: `${objectPath}?alt=media&ifGenerationMatch=${generation}&ifMetagenerationMatch=2`,
          headers: { authorization: "Bearer test-token" },
        })
        .reply(200, "new");

      const result = await readGcsReplicationSource(source);
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

  it("returns absent only for a live metadata 404", async () => {
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: objectPath })
      .reply(404);
    const result = await readGcsReplicationSource(source);
    expect(result.isOk() && result.value).toEqual({ status: "absent" });
    agent.assertNoPendingInterceptors();
  });

  it.each([404, 412])(
    "retries a change between metadata and content reads (%s)",
    async (code) => {
      const pool = agent.get("https://storage.googleapis.com");
      pool
        .intercept({ path: objectPath })
        .reply(200, GcsNotificationFactory.notification().metadata);
      pool.intercept({ path: mediaPath }).reply(code);

      const result = await readGcsReplicationSource(source);
      expect(result.isErr() && result.error.message).toBe(
        `GCS content read failed (${code}).`
      );
      agent.assertNoPendingInterceptors();
    }
  );

  it.each([403, 429, 500])(
    "does not treat a GCS failure as deletion (%s)",
    async (code) => {
      agent
        .get("https://storage.googleapis.com")
        .intercept({ path: objectPath })
        .reply(code);
      const result = await readGcsReplicationSource(source);
      expect(result.isErr() && result.error.message).toBe(
        `GCS metadata read failed (${code}).`
      );
    }
  );

  it("preserves compressed bytes as read through gcsfuse", async () => {
    const bytes = gzipSync("new");
    const metadata = GcsNotificationFactory.notification({
      metadata: { contentEncoding: "gzip", size: String(bytes.length) },
    }).metadata;
    const pool = agent.get("https://storage.googleapis.com");
    pool.intercept({ path: objectPath }).reply(200, metadata);
    pool
      .intercept({ path: mediaPath, headers: { "accept-encoding": "gzip" } })
      .reply(200, bytes, { headers: { "content-encoding": "gzip" } });

    const result = await readGcsReplicationSource(source);
    expect(result.isOk() && result.value.status).toBe("live");
    if (result.isOk() && result.value.status === "live") {
      expect(Buffer.concat(await result.value.stream.toArray())).toEqual(bytes);
    }
    agent.assertNoPendingInterceptors();
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
    const result = await readGcsReplicationSource(source);
    expect(result.isErr() && result.error.message).toBe(
      "GCS returned metadata for another object."
    );
    agent.assertNoPendingInterceptors();
  });

  it("keeps transport failures retryable", async () => {
    agent
      .get("https://storage.googleapis.com")
      .intercept({ path: objectPath })
      .replyWithError(new Error("connection reset"));
    const result = await readGcsReplicationSource(source);
    expect(result.isErr() && result.error.message).toBe("connection reset");
  });

  it("fails without reading GCS when credentials are unavailable", async () => {
    vi.mocked(GoogleAuth.prototype.getAccessToken).mockResolvedValue(null);
    const result = await readGcsReplicationSource(source);
    expect(result.isErr() && result.error.message).toBe(
      "GCP auth returned no access token."
    );
  });

  it("does not read content when the importer has been cancelled", async () => {
    const result = await readGcsReplicationSource(source, {
      signal: AbortSignal.abort(),
    });
    expect(result.isErr() && result.error.name).toBe("AbortError");
  });
});
