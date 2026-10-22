import { createServer } from "node:http";
import type { CollabAccess } from "@app/lib/api/collab/access";
import { checkCollabReadAccess } from "@app/lib/api/collab/access";
import { mintCollabTicket } from "@app/lib/api/collab/tickets";
import {
  dfmToYDoc,
  yDocCommentedTexts,
  yDocToDfm,
} from "@app/lib/api/collab/ydoc";
import { runOnRedisCollab } from "@app/lib/api/redis";
import { Authenticator } from "@app/lib/auth";
import { onAgentActivity, onAgentEdit } from "@app/lib/client/collab/agents";
import type { CommentChannel } from "@app/lib/client/collab/comments";
import { createCommentChannel } from "@app/lib/client/collab/comments";
import type { DfmComment } from "@app/lib/markdown/dfm";
import { CollabAgentFactory } from "@app/tests/utils/CollabAgentFactory";
import { commentAnchorOf } from "@app/tests/utils/comment_anchors";
import { FeatureFlagFactory } from "@app/tests/utils/FeatureFlagFactory";
import type {
  AgentEditMessage,
  CollabToken,
  InsertedIdRange,
} from "@app/types/collab";
import {
  BODY_FRAGMENT_NAME,
  EPOCH_CHANGED_CLOSE_REASON,
  toSessionName,
} from "@app/types/collab";
import { COLLAB_SOURCE_WRITE_WAIT_MS } from "@app/types/collab_internal";
import { Err, Ok } from "@app/types/shared/result";
import {
  saveNextRevision,
  COMMENTS,
  collabAccess,
  DOCUMENT_NAME,
  EPOCH,
  loadSource,
  SOURCE,
  typeInto,
} from "@front-api/collab/lib/collab.test_utils";
import {
  applyCommentRequest,
  dispatchSessionCommentMentions,
} from "@front-api/collab/lib/comments";
import {
  saveAllSessions,
  COMMENT_COMMAND_TIMEOUT_MS,
  createCollabHocuspocus,
  handleClientMessage,
  UNLOAD_GRACE_PERIOD_MS,
} from "@front-api/collab/lib/hocuspocus";
import {
  SAVE_RETRY_DELAY_MS,
  getSession,
  readSessionSource,
  showAgentActivity,
  writeSessionSource,
} from "@front-api/collab/lib/session";
import {
  CollabSaveError,
  keepConflictingFile,
  loadCollabSession,
  saveCollabSession,
} from "@front-api/collab/lib/session_file";
import {
  fetchYDocState,
  YDOC_STATE_TIMEOUT_MS,
} from "@front-api/collab/lib/ydoc_state";
import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Document, WebSocketLike } from "@hocuspocus/server";
import { Connection } from "@hocuspocus/server";
import type { Peer } from "crossws";
import crossws from "crossws/adapters/node";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import * as Y from "yjs";

vi.mock("@app/lib/api/collab/access", async (importActual) => {
  const actual =
    await importActual<typeof import("@app/lib/api/collab/access")>();
  return {
    ...actual,
    // Real until a test stubs it: minting a ticket and connecting both check access.
    checkCollabReadAccess: vi.fn(actual.checkCollabReadAccess),
  };
});

vi.mock("@front-api/collab/lib/session_file", async (importActual) => ({
  ...(await importActual<
    typeof import("@front-api/collab/lib/session_file")
  >()),
  loadCollabSession: vi.fn(),
  saveCollabSession: vi.fn(),
  keepConflictingFile: vi.fn(),
}));

vi.mock("@front-api/collab/lib/comments", () => ({
  applyCommentRequest: vi.fn(),
  dispatchSessionCommentMentions: vi.fn(async () => undefined),
}));

describe("createCollabHocuspocus", () => {
  beforeEach(() => {
    vi.mocked(loadCollabSession).mockImplementation(loadSource);
    saveNextRevision();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("saves each edit with the loaded threads, after the last revision written", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    // Faked once the database is set up, which needs real timers.
    vi.useFakeTimers();

    for (const text of ["First.", "Second."]) {
      const connection = await hocuspocus.openDirectConnection(
        DOCUMENT_NAME,
        writer
      );
      await connection.transact((doc) => typeInto(doc, text));
      await connection.disconnect();
    }

    const calls = vi.mocked(saveCollabSession).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0]).toBe(writer);
    expect(calls[0][1].comments).toBe(COMMENTS);
    expect(calls.map(([, , last]) => last.revision)).toEqual(["1", "2"]);
    expect(loadCollabSession).toHaveBeenCalledTimes(1);
  });

  it("saves every document at once on shutdown, edits waiting for their store included", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const edited = await hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);
    await edited.transact((doc) => typeInto(doc, "Not stored yet."));
    await hocuspocus.openDirectConnection("w1:user-u1/untouched.md", writer);
    expect(saveCollabSession).not.toHaveBeenCalled();

    await saveAllSessions(hocuspocus);

    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveCollabSession).mock.calls[0][0]).toBe(writer);
    // The debounced store it replaced does not run again.
    await vi.advanceTimersByTimeAsync(hocuspocus.configuration.maxDebounce);
    expect(saveCollabSession).toHaveBeenCalledTimes(1);
  });

  it("waits on shutdown for a document still loading", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    let finishLoad = () => {};
    vi.mocked(loadCollabSession).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        finishLoad = resolve;
      });
      return loadSource();
    });

    const opening = hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);
    let saved = false;
    const shutdown = saveAllSessions(hocuspocus).then(() => {
      saved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(saved).toBe(false);

    finishLoad();
    await opening;
    await shutdown;
    expect(saved).toBe(true);
  });

  it("keeps a document for the grace period, then reads the file again", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS - 1);
    expect(hocuspocus.getDocumentsCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hocuspocus.getDocumentsCount()).toBe(0);

    const reopened = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    expect(loadCollabSession).toHaveBeenCalledTimes(2);
    await reopened.disconnect();
  });

  it("keeps a document a client came back to during the grace period", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const first = await hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);
    await first.transact((doc) => typeInto(doc, "Edit."));
    await first.disconnect();

    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS - 1);
    const second = await hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS);
    expect(hocuspocus.getDocumentsCount()).toBe(1);

    await second.disconnect();
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS - 1);
    expect(hocuspocus.getDocumentsCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(hocuspocus.getDocumentsCount()).toBe(0);
    expect(loadCollabSession).toHaveBeenCalledTimes(1);
  });

  it("keeps a document whose save failed after the grace period", async () => {
    vi.mocked(saveCollabSession).mockResolvedValue(
      new Err(new CollabSaveError("failed", "The storage is down."))
    );
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS);
    expect(hocuspocus.getDocumentsCount()).toBe(1);
  });

  it("tells every connection when a save fails, retries it, and tells them once it saves", async () => {
    vi.mocked(saveCollabSession).mockResolvedValueOnce(
      new Err(new CollabSaveError("failed", "The storage is down."))
    );
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    const document = hocuspocus.documents.get(DOCUMENT_NAME);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(saveState(true));

    await vi.advanceTimersByTimeAsync(SAVE_RETRY_DELAY_MS - 1);
    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(saveCollabSession).toHaveBeenCalledTimes(2);
    expect(broadcast).toHaveBeenLastCalledWith(saveState(false));
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("keeps the file's version after a conflict, tells everyone, and saves over it", async () => {
    const COPY = "user-u1/notes (conflict 2026-10-14 14-05).md";
    vi.mocked(saveCollabSession)
      .mockResolvedValueOnce(
        new Err(new CollabSaveError("revision_conflict", "File changed."))
      )
      .mockImplementation(
        async (_file, _live, last) =>
          new Ok({ revision: "10", source: last.source })
      );
    vi.mocked(keepConflictingFile).mockResolvedValueOnce(
      new Ok({ lastSave: { revision: "9", source: "Theirs." }, copyPath: COPY })
    );
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    const document = hocuspocus.documents.get(DOCUMENT_NAME);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    const lastRevisions = vi
      .mocked(saveCollabSession)
      .mock.calls.map(([, , last]) => last.revision);
    expect(lastRevisions).toEqual(["1", "9"]);
    expect(broadcast).toHaveBeenCalledWith(saveState(false, COPY));
    expect(broadcast).not.toHaveBeenCalledWith(saveState(true));
  });

  it("stops saving over a file rewritten at every round, and fails the save", async () => {
    vi.mocked(saveCollabSession).mockResolvedValue(
      new Err(new CollabSaveError("revision_conflict", "File changed."))
    );
    vi.mocked(keepConflictingFile).mockImplementation(
      async () =>
        new Ok({
          lastSave: { revision: "9", source: "Theirs." },
          copyPath: "user-u1/notes (conflict 2026-10-14 14-05).md",
        })
    );
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    const document = hocuspocus.documents.get(DOCUMENT_NAME);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    // The first save, then one per round.
    expect(saveCollabSession).toHaveBeenCalledTimes(4);
    expect(keepConflictingFile).toHaveBeenCalledTimes(3);
    expect(broadcast).toHaveBeenLastCalledWith(
      saveState(true, "user-u1/notes (conflict 2026-10-14 14-05).md")
    );
  });

  it("saves the next round through whoever edited while the conflict was kept", async () => {
    const first = await collabAccess(true);
    const second: CollabAccess = {
      ...first,
      auth: (await collabAccess(true)).auth,
    };
    vi.mocked(saveCollabSession)
      .mockResolvedValueOnce(
        new Err(new CollabSaveError("revision_conflict", "File changed."))
      )
      .mockImplementation(
        async (_file, _live, last) =>
          new Ok({ revision: "10", source: last.source })
      );
    const hocuspocus = createCollabHocuspocus();
    vi.useFakeTimers();
    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      first
    );
    const document = hocuspocus.documents.get(DOCUMENT_NAME);
    if (!document) {
      throw new Error("The document did not load.");
    }
    vi.mocked(keepConflictingFile).mockImplementationOnce(async () => {
      // Another person edits while the file's version is being kept.
      const session = getSession(document);
      if (session) {
        session.lastChangedBy = second;
      }
      return new Ok({
        lastSave: { revision: "9", source: "Theirs." },
        copyPath: null,
      });
    });
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    const writers = vi
      .mocked(saveCollabSession)
      .mock.calls.map(([writer]) => writer.auth);
    expect(writers).toEqual([first.auth, second.auth]);
  });

  it("fails the save when a conflicting file cannot be kept", async () => {
    vi.mocked(saveCollabSession).mockResolvedValue(
      new Err(new CollabSaveError("revision_conflict", "File changed."))
    );
    vi.mocked(keepConflictingFile).mockResolvedValue(
      new Err(new Error("The file was deleted while it was open."))
    );
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    const document = hocuspocus.documents.get(DOCUMENT_NAME);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const broadcast = vi.spyOn(document, "broadcastStateless");
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenLastCalledWith(saveState(true));
  });

  /** A document whose saves fail, edited once by `writer`. */
  async function withFailingSaves() {
    vi.mocked(saveCollabSession).mockResolvedValue(
      new Err(new CollabSaveError("failed", "The storage is down."))
    );
    vi.mocked(applyCommentRequest).mockClear();
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    const name = toSessionName(writer.workspaceId, writer.canonicalPath);
    vi.useFakeTimers();

    const editing = await hocuspocus.openDirectConnection(name, writer);
    await editing.transact((doc) => typeInto(doc, "Edit."));
    hocuspocus.flushPendingStores();
    await vi.advanceTimersByTimeAsync(0);
    const document = hocuspocus.documents.get(name);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const request = new Request("http://localhost/api/collab");
    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    const browser = new Connection(socket, request, document, "s1", writer);
    return { hocuspocus, writer, name, document, request, browser };
  }

  it("refuses agent writes while saves fail", async () => {
    const { hocuspocus, writer, name } = await withFailingSaves();
    const read = await readSessionSource(hocuspocus, name);
    const base = read.isOk() && read.value.open ? read.value.source : "";

    expect(
      await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: `${base}\n\nMore.`,
      })
    ).toEqual(new Ok("unsaved"));
    const after = await readSessionSource(hocuspocus, name);
    expect(after.isOk() && after.value.open && after.value.source).toBe(base);
  });

  it("refuses comment commands while saves fail", async () => {
    const { hocuspocus, name, document, browser } = await withFailingSaves();
    const sent = vi.spyOn(browser, "sendStateless");

    await hocuspocus.hooks("onStateless", {
      connection: browser,
      document,
      documentName: name,
      payload: JSON.stringify({
        type: "command",
        requestId: "r1",
        command: { type: "add", commentId: "c9", body: "Hi." },
      }),
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toHaveBeenLastCalledWith(
      JSON.stringify({ type: "refused", requestId: "r1", error: "unavailable" })
    );
    expect(applyCommentRequest).not.toHaveBeenCalled();
  });

  it("tells a connection joining while saves fail", async () => {
    const { hocuspocus, writer, name, request, browser } =
      await withFailingSaves();
    const sent = vi.spyOn(browser, "sendStateless");

    await hocuspocus.hooks("connected", {
      connection: browser,
      context: writer,
      documentName: name,
      instance: hocuspocus,
      request,
      requestHeaders: request.headers,
      requestParameters: new URLSearchParams(),
      socketId: "s1",
      connectionConfig: { readOnly: false, isAuthenticated: true },
      providerVersion: null,
    });

    expect(sent).toHaveBeenCalledWith(saveState(true));
  });

  it("stores the Yjs state after each save, continuing from the revision written", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    const document = loadedDocument(hocuspocus, DOCUMENT_NAME);
    await connection.transact((doc) => typeInto(doc, "Stored."));
    await connection.disconnect();
    await getSession(document)?.pendingStateStore;

    const stored = await fetchYDocState(DOCUMENT_NAME);
    if (stored.isErr() || !stored.value) {
      throw new Error("No state was stored.");
    }
    expect(stored.value.revision).toBe("2");
    expect(stored.value.epoch).toBe(EPOCH);
    expect(stored.value.comments).toEqual(COMMENTS);
    expect(
      stored.value.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
    ).toContain("Stored.");
  });

  it("stores the Yjs state when a save fails, continuing from the last revision saved", async () => {
    const { name, document } = await withFailingSaves();
    await getSession(document)?.pendingStateStore;

    const stored = await fetchYDocState(name);

    expect(stored.isOk() && stored.value?.revision).toBe("1");
    expect(
      stored.isOk() &&
        stored.value?.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
    ).toContain("Edit.");
  });

  it("saves without waiting for Redis, and waits for it on shutdown", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    let answerRedis = () => {};
    const redisAnswered = new Promise<void>((resolve) => {
      answerRedis = resolve;
    });
    const slowRedis = async () => {
      await redisAnswered;
      return null;
    };
    // One state written for the edit's store, one for the shutdown's.
    vi.mocked(runOnRedisCollab)
      .mockImplementationOnce(slowRedis)
      .mockImplementationOnce(slowRedis);
    // The shutdown's bound on Redis never fires: a stop waiting for it would never end.
    vi.useFakeTimers();

    const editing = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    await editing.transact((doc) => typeInto(doc, "Edit."));
    await editing.disconnect();
    expect(saveCollabSession).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stop = async () => {
      await saveAllSessions(hocuspocus);
      stopped = true;
    };
    const stopping = stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(saveCollabSession).toHaveBeenCalledTimes(2);
    expect(stopped).toBe(false);

    answerRedis();
    await stopping;
    expect(runOnRedisCollab).toHaveBeenCalledTimes(2);
  });

  it("stops once YDOC_STATE_TIMEOUT_MS has passed when Redis never answers", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    vi.mocked(runOnRedisCollab).mockReturnValueOnce(new Promise(() => {}));
    vi.useFakeTimers();

    const editing = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    await editing.transact((doc) => typeInto(doc, "Edit."));
    await editing.disconnect();

    let stopped = false;
    const stop = async () => {
      await saveAllSessions(hocuspocus);
      stopped = true;
    };
    const stopping = stop();
    await vi.advanceTimersByTimeAsync(YDOC_STATE_TIMEOUT_MS - 1);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await stopping;
    expect(stopped).toBe(true);
  });

  it("keeps one state write pending per document, then writes the latest state", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
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
    vi.useFakeTimers();

    for (const text of ["First.", "Second.", "Third."]) {
      const connection = await hocuspocus.openDirectConnection(
        DOCUMENT_NAME,
        writer
      );
      await connection.transact((doc) => typeInto(doc, text));
      await connection.disconnect();
    }
    expect(saveCollabSession).toHaveBeenCalledTimes(3);
    expect(runOnRedisCollab).toHaveBeenCalledTimes(1);

    answerRedis();
    await getSession(loadedDocument(hocuspocus, DOCUMENT_NAME))
      ?.pendingStateStore;

    expect(runOnRedisCollab).toHaveBeenCalledTimes(2);
    const stored = await fetchYDocState(DOCUMENT_NAME);
    expect(stored.isOk() && stored.value?.revision).toBe("4");
    expect(
      stored.isOk() &&
        stored.value?.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
    ).toContain("Third.");
  });

  it("stores the loaded document once loaded when the load asks it", async () => {
    vi.mocked(loadCollabSession).mockImplementation(async () => {
      const loaded = await loadSource();
      return new Ok({ ...loaded.value, shouldStoreState: true });
    });
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);

    await hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);
    await getSession(loadedDocument(hocuspocus, DOCUMENT_NAME))
      ?.pendingStateStore;

    const stored = await fetchYDocState(DOCUMENT_NAME);
    expect(stored.isOk() && stored.value?.epoch).toBe(EPOCH);
    expect(stored.isOk() && stored.value?.revision).toBe("1");
    expect(
      stored.isOk() &&
        stored.value?.doc.getXmlFragment(BODY_FRAGMENT_NAME).toString()
    ).toContain("Hello.");
  });

  it("tells each connection the document's epoch once connected", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    await hocuspocus.openDirectConnection(DOCUMENT_NAME, writer);

    const sent = await connectBrowser(
      hocuspocus,
      loadedDocument(hocuspocus, DOCUMENT_NAME),
      writer
    );

    expect(sent).toHaveBeenCalledWith(
      JSON.stringify({ type: "epoch", epoch: EPOCH })
    );
  });

  it("saves the edits a load returned the file lacks, through the first writer to connect", async () => {
    vi.mocked(loadCollabSession).mockImplementation(async () => {
      const loaded = await loadSource();
      typeInto(loaded.value.content.doc, "Not saved.");
      return new Ok({ ...loaded.value, hasUnsavedEdits: true });
    });
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    const laterWriter = await collabAccess(true);
    const reader = await collabAccess(false);
    vi.useFakeTimers();

    await hocuspocus.openDirectConnection(DOCUMENT_NAME, reader);
    const document = loadedDocument(hocuspocus, DOCUMENT_NAME);
    await connectBrowser(hocuspocus, document, reader);
    await vi.advanceTimersByTimeAsync(hocuspocus.configuration.maxDebounce);
    expect(saveCollabSession).not.toHaveBeenCalled();

    await connectBrowser(hocuspocus, document, writer);
    await connectBrowser(hocuspocus, document, laterWriter);
    await vi.advanceTimersByTimeAsync(hocuspocus.configuration.maxDebounce);
    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    const [through, saved] = vi.mocked(saveCollabSession).mock.calls[0];
    expect(through).toBe(writer);
    const savedSource = yDocToDfm(saved);
    expect(savedSource.isOk() && savedSource.value).toContain("Not saved.");
  });

  it("saves through the last writer when a reader disconnects", async () => {
    const hocuspocus = createCollabHocuspocus();
    const writer = await collabAccess(true);
    const reader = await collabAccess(false);
    vi.useFakeTimers();

    const writing = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      writer
    );
    await writing.transact((doc) => typeInto(doc, "Edit."));
    const reading = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      reader
    );
    await reading.disconnect();
    expect(saveCollabSession).toHaveBeenCalledTimes(1);
    expect(vi.mocked(saveCollabSession).mock.calls[0][0]).toBe(writer);

    await writing.disconnect();
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS);
    expect(hocuspocus.getDocumentsCount()).toBe(0);
  });

  it("refuses to save an edit made without write access", async () => {
    const hocuspocus = createCollabHocuspocus();
    const reader = await collabAccess(false);
    vi.useFakeTimers();

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      reader
    );
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();

    expect(saveCollabSession).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(UNLOAD_GRACE_PERIOD_MS);
    expect(hocuspocus.getDocumentsCount()).toBe(1);
  });

  it("does not retry a save whose writer cannot write", async () => {
    const hocuspocus = createCollabHocuspocus();
    const reader = await collabAccess(false);
    vi.useFakeTimers();
    const stores = vi.spyOn(hocuspocus, "storeDocumentHooks");

    const connection = await hocuspocus.openDirectConnection(
      DOCUMENT_NAME,
      reader
    );
    await connection.transact((doc) => typeInto(doc, "Edit."));
    await connection.disconnect();
    const storesAfterEdit = stores.mock.calls.length;

    await vi.advanceTimersByTimeAsync(SAVE_RETRY_DELAY_MS * 4);
    expect(stores).toHaveBeenCalledTimes(storesAfterEdit);
  });
});

function loadedDocument(
  hocuspocus: ReturnType<typeof createCollabHocuspocus>,
  name: string
) {
  const document = hocuspocus.documents.get(name);
  if (!document) {
    throw new Error("The document did not load.");
  }
  return document;
}

/** Connects a browser to `document` as `context` would, returning what it is sent. */
async function connectBrowser(
  hocuspocus: ReturnType<typeof createCollabHocuspocus>,
  document: Document,
  context: CollabAccess
) {
  const request = new Request("http://localhost/api/collab");
  const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
  const browser = new Connection(socket, request, document, "s1", context);
  const sent = vi.spyOn(browser, "sendStateless");
  await hocuspocus.hooks("connected", {
    connection: browser,
    context,
    documentName: document.name,
    instance: hocuspocus,
    request,
    requestHeaders: request.headers,
    requestParameters: new URLSearchParams(),
    socketId: "s1",
    connectionConfig: { readOnly: !context.canWrite, isAuthenticated: true },
    providerVersion: null,
  });
  return sent;
}

function saveState(failed: boolean, conflictCopy: string | null = null) {
  return JSON.stringify({ type: "save_state", failed, conflictCopy });
}

async function ticketFor(auth: Authenticator, path: string) {
  const ticket = await mintCollabTicket(auth, path);
  if (ticket.isErr()) {
    throw new Error(ticket.error.message);
  }
  return ticket.value;
}

function isWebSocketLike(socket: unknown): socket is WebSocketLike {
  return typeof socket === "object" && socket !== null && "send" in socket;
}

/** Serves the Hocuspocus instance over WebSockets, as the collab server does. */
async function serve(hocuspocus: ReturnType<typeof createCollabHocuspocus>) {
  const connections = new WeakMap<
    Peer,
    ReturnType<typeof hocuspocus.handleConnection>
  >();
  const ws = crossws({
    hooks: {
      open(peer) {
        if (isWebSocketLike(peer.websocket)) {
          connections.set(
            peer,
            hocuspocus.handleConnection(peer.websocket, peer.request)
          );
        }
      },
      message(peer, message) {
        connections.get(peer)?.handleMessage(message.uint8Array());
      },
      close(peer, event) {
        connections.get(peer)?.handleClose({
          code: event.code ?? 1005,
          reason: event.reason ?? "",
        });
      },
    },
  });
  const server = createServer();
  server.on("upgrade", (request, socket, head) =>
    ws.handleUpgrade(request, socket, head)
  );
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("The test server has no port.");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: () => server.close(),
  };
}

describe("a browser that kept its document", () => {
  const providers: HocuspocusProvider[] = [];
  let close: () => void = () => undefined;

  afterEach(() => {
    providers.forEach((provider) => provider.destroy());
    providers.length = 0;
    close();
    vi.restoreAllMocks();
    vi.mocked(checkCollabReadAccess).mockReset();
  });

  // The socket handlers run outside the test's database transaction: authentication is stubbed.
  async function start() {
    const writer = await collabAccess(true);
    vi.spyOn(Authenticator, "fromUserIdAndWorkspaceId").mockResolvedValue(
      writer.auth
    );
    vi.mocked(checkCollabReadAccess).mockResolvedValue(new Ok(writer));
    vi.mocked(loadCollabSession).mockImplementation(loadSource);
    const hocuspocus = createCollabHocuspocus();
    const server = await serve(hocuspocus);
    close = server.close;
    const name = `${writer.workspaceId}:${writer.canonicalPath}`;
    const bodyOnServer = () =>
      loadedDocument(hocuspocus, name)
        .getXmlFragment(BODY_FRAGMENT_NAME)
        .toString();
    return { writer, name, url: server.url, bodyOnServer };
  }

  /** Connects with `doc`, sending `epoch` with the ticket when given, and the reasons it is closed. */
  async function connect(
    { writer, name, url }: Awaited<ReturnType<typeof start>>,
    doc: Y.Doc,
    epoch?: string
  ) {
    const ticket = await ticketFor(writer.auth, writer.canonicalPath);
    const closeReasons: string[] = [];
    const provider = new HocuspocusProvider({
      url,
      name,
      token:
        epoch === undefined
          ? ticket
          : JSON.stringify({ ticket, epoch } satisfies CollabToken),
      document: doc,
      onClose: ({ event }) => closeReasons.push(event.reason),
    });
    providers.push(provider);
    return { provider, closeReasons };
  }

  it("merges its offline edits when it sends the document's epoch", async () => {
    const started = await start();
    const doc = new Y.Doc();
    const first = await connect(started, doc);
    await new Promise<void>((resolve) => first.provider.on("synced", resolve));
    first.provider.destroy();

    typeInto(doc, "Offline.");
    const second = await connect(started, doc, EPOCH);
    await new Promise<void>((resolve) => second.provider.on("synced", resolve));

    await vi.waitFor(() =>
      expect(started.bodyOnServer()).toContain("Offline.")
    );
    expect(started.bodyOnServer().split("Hello.")).toHaveLength(2);
    expect(second.closeReasons).toEqual([]);
  });

  it("is closed before syncing when it sends another epoch", async () => {
    const started = await start();
    // The same text with other Yjs ids, as a document built again from its file.
    const kept = (await loadSource()).value.content.doc;
    typeInto(kept, "Offline.");

    const { closeReasons } = await connect(started, kept, "epoch-0");

    await vi.waitFor(() =>
      expect(closeReasons).toContain(EPOCH_CHANGED_CLOSE_REASON)
    );
    expect(started.bodyOnServer()).not.toContain("Offline.");
    expect(started.bodyOnServer().split("Hello.")).toHaveLength(2);
  });
});

// TODO(co-edition): cover commands applied one at a time per document, a message that is not a
// client message, a command whose document unloads before it finishes, and a command that times
// out.
describe("comment threads in a live session", () => {
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
  const CREATED: DfmComment = { ...THREAD, id: "c2" };
  const providers: HocuspocusProvider[] = [];
  const channels: CommentChannel[] = [];
  let close: () => void = () => undefined;

  beforeEach(() => {
    saveNextRevision();
    vi.mocked(dispatchSessionCommentMentions).mockClear();
  });

  afterEach(() => {
    channels.forEach((channel) => channel.close());
    providers.forEach((provider) => provider.destroy());
    close();
    vi.restoreAllMocks();
    vi.mocked(checkCollabReadAccess).mockReset();
  });

  // The socket handlers run outside the test's database transaction: authentication and the
  // commands, tested on their own, are stubbed.
  async function start() {
    const writer = await collabAccess(true);
    await FeatureFlagFactory.basic(writer.auth, "co_edition");
    vi.spyOn(Authenticator, "fromUserIdAndWorkspaceId").mockResolvedValue(
      writer.auth
    );
    vi.mocked(checkCollabReadAccess).mockResolvedValue(new Ok(writer));
    vi.mocked(loadCollabSession).mockImplementation(async () => {
      const live = dfmToYDoc(SOURCE);
      if (live.isErr()) {
        throw new Error(live.error);
      }
      const content = { doc: live.value.doc, comments: [THREAD] };
      const source = yDocToDfm(content);
      if (source.isErr()) {
        throw new Error(source.error);
      }
      return new Ok({
        content,
        lastSave: { revision: "1", source: source.value },
        epoch: EPOCH,
        hasUnsavedEdits: false,
        shouldStoreState: false,
      });
    });
    vi.mocked(applyCommentRequest).mockImplementation(
      async (_file, comments, command) =>
        command.type === "add"
          ? new Ok({
              comments: [...comments, CREATED],
              created: CREATED,
              added: CREATED.messages[0],
            })
          : new Err("thread_changed")
    );
    const hocuspocus = createCollabHocuspocus();
    const server = await serve(hocuspocus);
    close = server.close;
    return { writer, hocuspocus, url: server.url };
  }

  async function join(url: string, writer: CollabAccess) {
    // Each connection redeems a ticket of its own, a reconnection included.
    const tickets = [
      await ticketFor(writer.auth, writer.canonicalPath),
      await ticketFor(writer.auth, writer.canonicalPath),
    ];
    const provider = new HocuspocusProvider({
      url,
      name: `${writer.workspaceId}:${writer.canonicalPath}`,
      token: () => tickets.shift() ?? "",
      document: new Y.Doc(),
    });
    providers.push(provider);
    await new Promise<void>((resolve) => provider.on("synced", resolve));
    const channel = createCommentChannel(provider, null);
    channels.push(channel);
    await vi.waitFor(() => expect(channel.getThreads()).not.toBeNull());
    return { channel, provider };
  }

  it("serves the threads, applies a command for every connection and saves it", async () => {
    const { writer, hocuspocus, url } = await start();
    const { channel: mine } = await join(url, writer);
    const { channel: theirs } = await join(url, writer);
    expect(mine.getThreads()).toEqual([THREAD]);

    const added = await mine.send({
      type: "add",
      commentId: "c2",
      body: "Ship it.",
    });
    expect(added.isOk() && added.value).toEqual(CREATED);
    const [file] = vi.mocked(applyCommentRequest).mock.calls[0];
    expect(file.auth).toBe(writer.auth);
    expect(file.canonicalPath).toBe(writer.canonicalPath);

    await vi.waitFor(() =>
      expect(theirs.getThreads()).toEqual([THREAD, CREATED])
    );
    hocuspocus.flushPendingStores();
    await vi.waitFor(() =>
      expect(
        vi.mocked(saveCollabSession).mock.calls.at(-1)?.[1].comments
      ).toEqual([THREAD, CREATED])
    );

    const refused = await theirs.send({
      type: "reply",
      commentId: "c1",
      position: 2,
      body: "Late.",
    });
    expect(refused.isErr() && refused.error).toBe("thread_changed");
    expect(theirs.getThreads()).toEqual([THREAD, CREATED]);
    expect(dispatchSessionCommentMentions).toHaveBeenCalledOnce();
    expect(vi.mocked(dispatchSessionCommentMentions).mock.calls[0]).toEqual([
      file,
      expect.anything(),
      expect.objectContaining({ type: "add", commentId: "c2" }),
      CREATED.messages[0],
      expect.any(Function),
    ]);

    const invalid = await mine.send({
      type: "add",
      commentId: "c3",
      body: "",
    });
    expect(invalid.isErr() && invalid.error).toBe("unavailable");
    expect(applyCommentRequest).toHaveBeenCalledTimes(2);

    mine.close();
    expect(mine.getThreads()).toBeNull();
    const late = await mine.send({ type: "delete", commentId: "c2" });
    expect(late.isErr() && late.error).toBe("unavailable");
  }, 15_000);

  it("refuses a command that throws once applied, and resolves only once it is answered", async () => {
    const { writer, hocuspocus } = await start();
    const documentName = `${writer.workspaceId}:${writer.canonicalPath}`;
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      writer
    );
    const document = hocuspocus.documents.get(documentName);
    if (!document) {
      throw new Error("The document did not load.");
    }
    vi.spyOn(document, "broadcastStateless").mockImplementation(() => {
      throw new Error("The broadcast failed.");
    });
    const reply = vi.fn();

    await handleClientMessage(hocuspocus, {
      document,
      file: writer,
      payload: JSON.stringify({
        type: "command",
        requestId: "r1",
        command: { type: "add", commentId: "c2", body: "Ship it." },
      }),
      reply,
    });
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: "refused", requestId: "r1", error: "unavailable" })
    );
    await connection.disconnect();
  });

  it("keeps applying later commands when a refusal cannot be sent", async () => {
    const { writer, hocuspocus } = await start();
    const documentName = `${writer.workspaceId}:${writer.canonicalPath}`;
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      writer
    );
    const document = hocuspocus.documents.get(documentName);
    if (!document) {
      throw new Error("The document did not load.");
    }
    vi.spyOn(document, "broadcastStateless").mockImplementationOnce(() => {
      throw new Error("The broadcast failed.");
    });
    const command = (requestId: string, commentId: string) =>
      JSON.stringify({
        type: "command",
        requestId,
        command: { type: "add", commentId, body: "Ship it." },
      });

    await handleClientMessage(hocuspocus, {
      document,
      file: writer,
      payload: command("r1", "c2"),
      reply: () => {
        throw new Error("The reply failed.");
      },
    });
    const third: DfmComment = { ...THREAD, id: "c3" };
    vi.mocked(applyCommentRequest).mockImplementationOnce(
      async (_file, comments) =>
        new Ok({
          comments: [...comments, third],
          created: third,
          added: third.messages[0],
        })
    );
    const reply = vi.fn();
    await handleClientMessage(hocuspocus, {
      document,
      file: writer,
      payload: command("r2", "c3"),
      reply,
    });
    expect(reply).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ type: "accepted", requestId: "r2", comment: third })
    );
    expect(getSession(document)?.comments).toEqual([THREAD, CREATED, third]);
    await connection.disconnect();
  });

  it("keeps a command applied, saved and dispatched when its answer cannot be sent", async () => {
    const { writer, hocuspocus } = await start();
    const documentName = `${writer.workspaceId}:${writer.canonicalPath}`;
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      writer
    );
    const document = hocuspocus.documents.get(documentName);
    if (!document) {
      throw new Error("The document did not load.");
    }
    const reply = vi.fn(() => {
      throw new Error("The reply failed.");
    });

    await expect(
      handleClientMessage(hocuspocus, {
        document,
        file: writer,
        payload: JSON.stringify({ type: "threads" }),
        reply,
      })
    ).resolves.toBeUndefined();
    await handleClientMessage(hocuspocus, {
      document,
      file: writer,
      payload: JSON.stringify({
        type: "command",
        requestId: "r1",
        command: { type: "add", commentId: "c2", body: "Ship it." },
      }),
      reply,
    });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(getSession(document)?.comments).toEqual([THREAD, CREATED]);
    expect(dispatchSessionCommentMentions).toHaveBeenCalledOnce();
    hocuspocus.flushPendingStores();
    await vi.waitFor(() =>
      expect(
        vi.mocked(saveCollabSession).mock.calls.at(-1)?.[1].comments
      ).toEqual([THREAD, CREATED])
    );
    await connection.disconnect();
  });

  it("marks an added thread's text before answering it, and refuses one it cannot anchor", async () => {
    const { writer, hocuspocus, url } = await start();
    const { channel: mine, provider: myProvider } = await join(url, writer);
    const { channel: theirs, provider: theirProvider } = await join(
      url,
      writer
    );

    const added = await mine.send({
      type: "add",
      commentId: "c2",
      body: "Ship it.",
      anchor: commentAnchorOf(myProvider.document, "Hello"),
    });
    expect(added.isOk() && added.value).toEqual(CREATED);
    expect(yDocCommentedTexts(myProvider.document).get("c2")).toBe("Hello");
    await vi.waitFor(() =>
      expect(theirs.getThreads()).toEqual([THREAD, CREATED])
    );
    expect(yDocCommentedTexts(theirProvider.document).get("c2")).toBe("Hello");
    // The mark is no connection's change of the text.
    const document = hocuspocus.documents.get(
      toSessionName(writer.workspaceId, writer.canonicalPath)
    );
    expect(document && getSession(document)?.lastChangedBy).toBeUndefined();

    const outside = { item: { client: 1, clock: 999_999 }, assoc: -1 as const };
    const refused = await mine.send({
      type: "add",
      commentId: "c3",
      body: "Nowhere.",
      anchor: { first: outside, last: outside },
    });
    expect(refused.isErr() && refused.error).toBe("unanchored");
    expect(mine.getThreads()).toEqual([THREAD, CREATED]);
    expect(yDocCommentedTexts(myProvider.document).has("c3")).toBe(false);
  }, 15_000);

  it("shows every connection the agent a comment's mentions run", async () => {
    const { writer, url } = await start();
    const { channel: mine, provider: myProvider } = await join(url, writer);
    const { provider: theirs } = await join(url, writer);
    const seen: string[] = [];
    const listen = (who: string, provider: HocuspocusProvider) =>
      onAgentActivity(provider, ({ agent, activity }) =>
        seen.push(`${who}: ${agent.name} ${agent.commentId} ${activity}`)
      );
    listen("mine", myProvider);
    listen("theirs", theirs);

    await mine.send({ type: "add", commentId: "c2", body: "Ship it." });
    const [, , , , show] = vi.mocked(dispatchSessionCommentMentions).mock
      .calls[0];
    show(CollabAgentFactory.build({ commentId: "c2" }), "waiting");

    await vi.waitFor(() =>
      expect(seen.sort()).toEqual([
        "mine: Writer c2 waiting",
        "theirs: Writer c2 waiting",
      ])
    );
  }, 15_000);

  it("saves comments through the latest commenter when nobody changed the text", async () => {
    const first = await collabAccess(true);
    const second: CollabAccess = {
      ...first,
      auth: (await collabAccess(true)).auth,
    };
    vi.mocked(loadCollabSession).mockImplementation(loadSource);
    saveNextRevision();
    vi.mocked(applyCommentRequest).mockImplementation(
      async (_file, comments) =>
        new Ok({
          comments: [...comments, CREATED],
          created: CREATED,
          added: CREATED.messages[0],
        })
    );
    const hocuspocus = createCollabHocuspocus();
    const documentName = toSessionName(first.workspaceId, first.canonicalPath);
    await hocuspocus.openDirectConnection(documentName, first);
    const document = hocuspocus.documents.get(documentName);
    if (!document) {
      throw new Error("The document did not load.");
    }

    // Two browsers' connections, each sending a comment command. They are built directly rather
    // than joined over WebSockets: in this harness, joined connections end up with one context.
    const request = new Request("http://localhost/api/collab");
    for (const [index, context] of [first, second].entries()) {
      const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
      const connection = new Connection(
        socket,
        request,
        document,
        "socket",
        context
      );
      const answered = vi.spyOn(connection, "sendStateless");
      await hocuspocus.hooks("onStateless", {
        connection,
        document,
        documentName,
        payload: JSON.stringify({
          type: "command",
          requestId: `r${index}`,
          command: { type: "add", commentId: `c${index + 2}`, body: "Hi." },
        }),
      });
      await vi.waitFor(() => expect(answered).toHaveBeenCalled());
    }

    hocuspocus.flushPendingStores();
    await vi.waitFor(() =>
      expect(vi.mocked(saveCollabSession).mock.calls.at(-1)?.[0].auth).toBe(
        second.auth
      )
    );
  });

  it("refuses a command whose turn comes after its deadline, without applying it", async () => {
    const file = await collabAccess(true);
    vi.mocked(loadCollabSession).mockImplementation(loadSource);
    vi.mocked(applyCommentRequest).mockClear();
    vi.mocked(applyCommentRequest).mockImplementation(
      () => new Promise(() => undefined)
    );
    const hocuspocus = createCollabHocuspocus();
    const documentName = toSessionName(file.workspaceId, file.canonicalPath);
    await hocuspocus.openDirectConnection(documentName, file);
    const document = hocuspocus.documents.get(documentName);
    if (!document) {
      throw new Error("The document did not load.");
    }
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });

    const socket = { send: vi.fn(), close: vi.fn(), readyState: 1 };
    const connection = new Connection(
      socket,
      new Request("http://localhost/api/collab"),
      document,
      "socket",
      file
    );
    const answered = vi.spyOn(connection, "sendStateless");
    for (const requestId of ["r1", "r2"]) {
      await hocuspocus.hooks("onStateless", {
        connection,
        document,
        documentName,
        payload: JSON.stringify({
          type: "command",
          requestId,
          command: { type: "add", commentId: requestId, body: "Hi." },
        }),
      });
    }

    // The first command runs out the time the second also had, waiting behind it.
    await vi.advanceTimersByTimeAsync(COMMENT_COMMAND_TIMEOUT_MS);
    expect(applyCommentRequest).toHaveBeenCalledTimes(1);
    expect(answered.mock.calls.map(([message]) => JSON.parse(message))).toEqual(
      ["r1", "r2"].map((requestId) => ({
        type: "refused",
        requestId,
        error: "unavailable",
      }))
    );
  });

  it("saves a comment through the connection that last changed the text", async () => {
    const { writer, hocuspocus, url } = await start();
    const { channel } = await join(url, writer);
    const editor = await collabAccess(true);
    const editing = await hocuspocus.openDirectConnection(
      `${writer.workspaceId}:${writer.canonicalPath}`,
      editor
    );
    await editing.transact((doc) => typeInto(doc, "Edit."));

    const added = await channel.send({
      type: "add",
      commentId: "c2",
      body: "Ship it.",
    });
    expect(added.isOk()).toBe(true);

    hocuspocus.flushPendingStores();
    await vi.waitFor(() => {
      const [through, live] =
        vi.mocked(saveCollabSession).mock.calls.at(-1) ?? [];
      expect(live?.comments).toEqual([THREAD, CREATED]);
      expect(through).toBe(editor);
    });
    await editing.disconnect();
  }, 15_000);

  it("fails the commands a lost connection waits for, then asks for the threads again", async () => {
    const { writer, url } = await start();
    const mine = await join(url, writer);
    const { channel: theirs } = await join(url, writer);
    let release = () => {};
    vi.mocked(applyCommentRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve(new Err("thread_changed"));
        })
    );

    const waiting = mine.channel.send({ type: "delete", commentId: "c1" });
    await vi.waitFor(() =>
      expect(applyCommentRequest).toHaveBeenCalledTimes(1)
    );
    mine.provider.disconnect();
    const lost = await waiting;
    expect(lost.isErr() && lost.error).toBe("unavailable");
    const offline = await mine.channel.send({
      type: "delete",
      commentId: "c1",
    });
    expect(offline.isErr() && offline.error).toBe("unavailable");

    release();
    const added = await theirs.send({
      type: "add",
      commentId: "c2",
      body: "Ship it.",
    });
    expect(added.isOk()).toBe(true);
    expect(mine.channel.getThreads()).toEqual([THREAD]);

    await mine.provider.connect();
    await vi.waitFor(() =>
      expect(mine.channel.getThreads()).toEqual([THREAD, CREATED])
    );
  }, 15_000);

  describe("a write from an agent", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // Holds the next command until `release`, then accepts or refuses it.
    function holdNextAdd(outcome: "accepted" | "refused") {
      const held = { release: () => {} };
      vi.mocked(applyCommentRequest).mockImplementationOnce(
        (_file, comments) =>
          new Promise((resolve) => {
            held.release = () =>
              resolve(
                outcome === "accepted"
                  ? new Ok({
                      comments: [...comments, CREATED],
                      created: CREATED,
                      added: CREATED.messages[0],
                    })
                  : new Err("thread_changed")
              );
          })
      );
      return held;
    }

    async function startWithHeldAdd(
      outcome: "accepted" | "refused" = "accepted"
    ) {
      const { writer, hocuspocus, url } = await start();
      const { channel } = await join(url, writer);
      const name = toSessionName(writer.workspaceId, writer.canonicalPath);
      const read = await readSessionSource(hocuspocus, name);
      if (read.isErr() || !read.value.open) {
        throw new Error("The document is not open.");
      }
      const base = read.value.source;
      const held = holdNextAdd(outcome);
      const adding = channel.send({
        type: "add",
        commentId: "c2",
        body: "Ship it.",
      });
      await vi.waitFor(() =>
        expect(applyCommentRequest).toHaveBeenCalledTimes(1)
      );
      const edit = () =>
        writeSessionSource(hocuspocus, {
          file: writer,
          base,
          source: base.replace("Hello.", "Hello, edited."),
        });
      return { hocuspocus, name, channel, held, adding, edit };
    }

    async function writeBehindHeldAdd(
      outcome: "accepted" | "refused" = "accepted"
    ) {
      const started = await startWithHeldAdd(outcome);
      const writing = started.edit();
      // Past the document lookup, the write now waits for its turn.
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { ...started, writing };
    }

    async function liveSource(
      hocuspocus: ReturnType<typeof createCollabHocuspocus>,
      name: string
    ) {
      const read = await readSessionSource(hocuspocus, name);
      return read.isOk() && read.value.open ? read.value.source : null;
    }

    it("waits for the comment command before it, then compares with its threads", async () => {
      const { hocuspocus, name, channel, held, adding, writing } =
        await writeBehindHeldAdd();

      held.release();

      expect((await adding).isOk()).toBe(true);
      expect(await writing).toEqual(new Ok("changed"));
      await vi.waitFor(() =>
        expect(channel.getThreads()).toEqual([THREAD, CREATED])
      );
      const read = await readSessionSource(hocuspocus, name);
      expect(read.isOk() && read.value.open && read.value.source).not.toContain(
        "edited"
      );
    }, 15_000);

    it("answers closed when its document unloads while it waits", async () => {
      const { hocuspocus, name, held, adding, writing } =
        await writeBehindHeldAdd();

      // What `unloadDocument` ends with, which the grace period would otherwise delay by minutes.
      const document = hocuspocus.documents.get(name);
      hocuspocus.documents.delete(name);
      document?.destroy();
      held.release();

      const added = await adding;
      expect(added.isErr() && added.error).toBe("unavailable");
      expect(await writing).toEqual(new Ok("closed"));
    }, 15_000);

    it("answers busy, and never applies, when its turn does not come in time", async () => {
      const { hocuspocus, name, held, adding, edit } =
        await startWithHeldAdd("refused");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

      const writing = edit();
      await vi.advanceTimersByTimeAsync(COLLAB_SOURCE_WRITE_WAIT_MS);
      expect(await writing).toEqual(new Ok("busy"));

      vi.useRealTimers();
      held.release();
      expect((await adding).isErr()).toBe(true);
      expect(await liveSource(hocuspocus, name)).not.toContain("edited");
    }, 15_000);

    it("finishes the queued writes before the shutdown save, then answers busy", async () => {
      const { hocuspocus, name, held, writing, edit } =
        await writeBehindHeldAdd("refused");

      const stopping = saveAllSessions(hocuspocus);
      expect(await edit()).toEqual(new Ok("busy"));
      held.release();
      await stopping;

      expect(await writing).toEqual(new Ok("written"));
      expect(await liveSource(hocuspocus, name)).toContain("edited");
      const [, live] = vi.mocked(saveCollabSession).mock.calls.at(-1) ?? [];
      const saved = live ? yDocToDfm(live) : null;
      expect(saved?.isOk() && saved.value).toContain("edited");
    }, 15_000);
  });

  describe("an agent's activity", () => {
    const AGENT = CollabAgentFactory.build();

    /** What reaches a browser, in order: agent messages and document updates. */
    async function watch() {
      const { writer, hocuspocus, url } = await start();
      const { provider } = await join(url, writer);
      const name = toSessionName(writer.workspaceId, writer.canonicalPath);
      const seen: string[] = [];
      const edits: AgentEditMessage[] = [];
      onAgentActivity(provider, ({ agent, activity }) =>
        seen.push(`${agent.name} ${activity}`)
      );
      onAgentEdit(provider, (edit) => {
        edits.push(edit);
        seen.push(`${edit.agent.name} edit`);
      });
      provider.document.on("update", () => seen.push("update"));
      const read = await readSessionSource(hocuspocus, name);
      if (read.isErr() || !read.value.open) {
        throw new Error("The document is not open.");
      }
      return {
        writer,
        hocuspocus,
        name,
        seen,
        edits,
        browser: provider.document,
        base: read.value.source,
      };
    }

    /** The text of `ranges` the browser's document holds, as the editor resolves it. */
    const textOf = (document: Y.Doc, ranges: InsertedIdRange[]) =>
      ranges
        .map(({ client, clock, length }) => {
          const structs = document.store.clients.get(client) ?? [];
          let text = "";
          for (
            let index = Y.findIndexSS(structs, clock);
            index < structs.length && structs[index].id.clock < clock + length;
            index++
          ) {
            const item = structs[index];
            if (
              item instanceof Y.Item &&
              !item.deleted &&
              item.content instanceof Y.ContentString
            ) {
              const from = Math.max(clock, item.id.clock) - item.id.clock;
              const to =
                Math.min(clock + length, item.id.clock + item.length) -
                item.id.clock;
              text += item.content.str.slice(from, to);
            }
          }
          return text;
        })
        .join("");

    // With Hocuspocus's batching, an announcement sent after the change would also arrive first; this
    // checks what the browser receives, not the order in the code.
    it("announces an agent's edit before the edit reaches the browser", async () => {
      const { writer, hocuspocus, seen, base } = await watch();

      const written = await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: base.replace("Hello.", "Hello, edited."),
        agent: AGENT,
      });

      expect(written).toEqual(new Ok("written"));
      await vi.waitFor(() => expect(seen).toContain("update"));
      expect(seen[0]).toBe("Writer editing");
    }, 15_000);

    it("announces the text the agent inserted after its update, by ids the browser resolves", async () => {
      const { writer, hocuspocus, seen, edits, browser, base } = await watch();

      await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: base.replace("Hello.", "Hello, edited."),
        agent: AGENT,
      });

      await vi.waitFor(() =>
        expect(seen).toEqual(["Writer editing", "update", "Writer edit"])
      );
      expect(edits[0].agent).toEqual(AGENT);
      expect(textOf(browser, edits[0].inserted)).toBe(", edited");
    }, 15_000);

    it("sends someone else's pending change with the agent's, before its announcement", async () => {
      const { writer, hocuspocus, name, seen, edits, browser, base } =
        await watch();
      const document = hocuspocus.documents.get(name);
      if (!document) {
        throw new Error("The document is not open.");
      }

      // Still in Hocuspocus's flush window when the agent writes, and invisible in the source.
      document.getMap("elsewhere").set("touched", true);
      await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: base.replace("Hello.", "Hello, edited."),
        agent: AGENT,
      });

      await vi.waitFor(() =>
        expect(seen).toEqual(["Writer editing", "update", "Writer edit"])
      );
      expect(textOf(browser, edits[0].inserted)).toBe(", edited");
    }, 15_000);

    it("takes the announcement back when the agent only changes front matter", async () => {
      const { writer, hocuspocus, seen, base } = await watch();

      const written = await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: `---\ntitle: Notes\n---\n\n${base}`,
        agent: AGENT,
      });

      expect(written).toEqual(new Ok("written"));
      await vi.waitFor(() =>
        expect(seen).toEqual(["Writer editing", "Writer reading", "update"])
      );
    }, 15_000);

    it("takes the announcement back when the agent's source changes nothing in the document", async () => {
      const { writer, hocuspocus, seen, base } = await watch();
      const bold = base.replace("Hello.", "**Hello.**");
      await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: bold,
      });
      await vi.waitFor(() => expect(seen).toEqual(["update"]));

      // Another spelling of the same document: the editor's model does not change.
      const written = await writeSessionSource(hocuspocus, {
        file: writer,
        base: bold,
        source: bold.replace("**Hello.**", "__Hello.__"),
        agent: AGENT,
      });

      expect(written).toEqual(new Ok("written"));
      await vi.waitFor(() =>
        expect(seen).toEqual(["update", "Writer editing", "Writer reading"])
      );
    }, 15_000);

    it("announces an edit that only deletes text, with nothing inserted", async () => {
      const { writer, hocuspocus, seen, edits, base } = await watch();

      const written = await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: base.replace("Hello.", "Hello"),
        agent: AGENT,
      });

      expect(written).toEqual(new Ok("written"));
      await vi.waitFor(() =>
        expect(seen).toEqual(["Writer editing", "update", "Writer edit"])
      );
      expect(edits[0].inserted).toEqual([]);
    }, 15_000);

    it("announces nothing for a write without an agent, or one that changes nothing", async () => {
      const { writer, hocuspocus, seen, base } = await watch();
      const edited = base.replace("Hello.", "Hello, edited.");

      await writeSessionSource(hocuspocus, {
        file: writer,
        base,
        source: edited,
      });
      expect(
        await writeSessionSource(hocuspocus, {
          file: writer,
          base: edited,
          source: edited,
          agent: AGENT,
        })
      ).toEqual(new Ok("written"));

      await vi.waitFor(() => expect(seen).toContain("update"));
      expect(seen.filter((event) => event !== "update")).toEqual([]);
    }, 15_000);

    it("shows an agent reading the document", async () => {
      const { hocuspocus, name, seen } = await watch();

      showAgentActivity(hocuspocus, name, AGENT, "reading");

      await vi.waitFor(() => expect(seen).toEqual(["Writer reading"]));
    }, 15_000);
  });
});
