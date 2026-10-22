import { dfmToYDoc } from "@app/lib/api/collab/ydoc";
import { runOnRedisCollab } from "@app/lib/api/redis";
import type { DfmComment } from "@app/lib/markdown/dfm";
import logger from "@app/logger/logger";
import { BODY_FRAGMENT_NAME } from "@app/types/collab";
import {
  fetchYDocState,
  storeYDocState,
  YDOC_STATE_MAX_BYTES,
  YDOC_STATE_TIMEOUT_MS,
} from "@front-api/collab/lib/ydoc_state";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

const DOCUMENT_NAME = "w1:user-u1/notes.md";
const THREAD: DfmComment = {
  id: "c1",
  status: "open",
  messages: [
    {
      author: { kind: "user", id: "usr_tom", name: "Tom" },
      createdAt: "2026-10-05T12:00:00.000Z",
      body: "Why Friday?",
    },
  ],
};

function loadDoc(source: string): Y.Doc {
  const content = dfmToYDoc(source);
  if (content.isErr()) {
    throw new Error(content.error);
  }
  return content.value.doc;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const ttlOf = (documentName: string) =>
  runOnRedisCollab({ origin: "collab_ydoc_state" }, (redis) =>
    redis.ttl(`collab_ydoc_state:${documentName}`)
  );

describe("storeYDocState and fetchYDocState", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("round trip the document with its Yjs ids, epoch, revision and threads", async () => {
    const doc = loadDoc("# Notes\n\nHello.\n");

    const stored = await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "7",
      doc,
      comments: [THREAD],
    });
    expect(stored.isOk() && stored.value).toBe("stored");

    const fetched = await fetchYDocState(DOCUMENT_NAME);
    if (fetched.isErr() || !fetched.value) {
      throw new Error("Nothing was fetched.");
    }
    expect(fetched.value.epoch).toBe("e1");
    expect(fetched.value.revision).toBe("7");
    expect(fetched.value.comments).toEqual([THREAD]);
    expect(Y.encodeStateVector(fetched.value.doc)).toEqual(
      Y.encodeStateVector(doc)
    );
    // Merging the original into the fetched copy adds nothing: they share their ids.
    Y.applyUpdate(fetched.value.doc, Y.encodeStateAsUpdate(doc));
    expect(
      fetched.value.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
    ).toBe(doc.getXmlFragment(BODY_FRAGMENT_NAME).toString());
  });

  it("expire a day after being stored", async () => {
    vi.useFakeTimers();
    await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "7",
      doc: loadDoc("# Notes\n"),
      comments: [],
    });

    vi.advanceTimersByTime(DAY_MS - 1000);
    expect(await ttlOf(DOCUMENT_NAME)).toBeGreaterThan(0);
    vi.advanceTimersByTime(2000);
    const fetched = await fetchYDocState(DOCUMENT_NAME);
    expect(fetched.isOk() && fetched.value).toBeNull();
  });

  it("expire a day after being fetched", async () => {
    vi.useFakeTimers();
    await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "7",
      doc: loadDoc("# Notes\n"),
      comments: [],
    });
    vi.advanceTimersByTime(DAY_MS / 2);
    await fetchYDocState(DOCUMENT_NAME);

    vi.advanceTimersByTime(DAY_MS - 1000);
    expect(await ttlOf(DOCUMENT_NAME)).toBeGreaterThan(0);
    vi.advanceTimersByTime(2000);
    const fetched = await fetchYDocState(DOCUMENT_NAME);
    expect(fetched.isOk() && fetched.value).toBeNull();
  });

  it("refuse a state too large and delete the one stored before", async () => {
    await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "7",
      doc: loadDoc("# Notes\n"),
      comments: [],
    });

    const doc = loadDoc("# Notes\n");
    doc.getText("filler").insert(0, "a".repeat(YDOC_STATE_MAX_BYTES));
    const large = await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "8",
      doc,
      comments: [],
    });

    expect(large.isOk() && large.value).toBe("too_large");
    const fetched = await fetchYDocState(DOCUMENT_NAME);
    expect(fetched.isOk() && fetched.value).toBeNull();
  });

  it("return nothing for a document never stored or a state that cannot be read, logging the latter", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const missing = await fetchYDocState(DOCUMENT_NAME);
    expect(missing.isOk() && missing.value).toBeNull();
    expect(warn).not.toHaveBeenCalled();

    await runOnRedisCollab({ origin: "collab_ydoc_state" }, (redis) =>
      redis.set(`collab_ydoc_state:${DOCUMENT_NAME}`, "{not json")
    );
    const unreadable = await fetchYDocState(DOCUMENT_NAME);
    expect(unreadable.isOk() && unreadable.value).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        documentName: DOCUMENT_NAME,
        workspaceId: "w1",
      }),
      "Collab document state unreadable"
    );
  });

  it("fail when Redis fails", async () => {
    vi.mocked(runOnRedisCollab)
      .mockRejectedValueOnce(new Error("Redis is down."))
      .mockRejectedValueOnce(new Error("Redis is down."));

    const stored = await storeYDocState(DOCUMENT_NAME, {
      epoch: "e1",
      revision: "7",
      doc: loadDoc("# Notes\n"),
      comments: [],
    });
    const fetched = await fetchYDocState(DOCUMENT_NAME);

    expect(stored.isErr()).toBe(true);
    expect(fetched.isErr()).toBe(true);
  });

  it("fail to fetch when Redis does not answer in time", async () => {
    vi.useFakeTimers();
    vi.mocked(runOnRedisCollab).mockReturnValueOnce(new Promise(() => {}));

    const fetching = fetchYDocState(DOCUMENT_NAME);
    await vi.advanceTimersByTimeAsync(YDOC_STATE_TIMEOUT_MS);

    expect((await fetching).isErr()).toBe(true);
  });

  it("store only once Redis answered, however long it takes", async () => {
    vi.useFakeTimers();
    const answer = vi.mocked(runOnRedisCollab).getMockImplementation();
    if (!answer) {
      throw new Error("Redis is not mocked.");
    }
    let answerRedis = () => {};
    const redisAnswered = new Promise<void>((resolve) => {
      answerRedis = resolve;
    });
    vi.mocked(runOnRedisCollab).mockImplementationOnce(async (opts, run) => {
      await redisAnswered;
      return answer(opts, run);
    });

    let settled = false;
    const store = async () => {
      const stored = await storeYDocState(DOCUMENT_NAME, {
        epoch: "e1",
        revision: "7",
        doc: loadDoc("# Notes\n"),
        comments: [],
      });
      settled = true;
      return stored;
    };
    const storing = store();
    await vi.advanceTimersByTimeAsync(YDOC_STATE_TIMEOUT_MS * 10);
    expect(settled).toBe(false);

    answerRedis();
    const stored = await storing;
    expect(stored.isOk() && stored.value).toBe("stored");
  });
});
