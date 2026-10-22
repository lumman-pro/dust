import type { CollabAccess } from "@app/lib/api/collab/access";
import {
  anchorYDocComment,
  getYDocUnsavableBodyReason,
} from "@app/lib/api/collab/ydoc";
import type { DfmMessage } from "@app/lib/markdown/dfm";
import {
  concurrentExecutor,
  raceWithTimeout,
  setTimeoutAsync,
} from "@app/lib/utils/async_utils";
import logger from "@app/logger/logger";
import {
  applyCommentRequest,
  dispatchSessionCommentMentions,
} from "@front-api/collab/lib/comments";
import { loadCollabSession } from "@front-api/collab/lib/session_file";
import { YDOC_STATE_TIMEOUT_MS } from "@front-api/collab/lib/ydoc_state";

import type {
  CommentRequest,
  CommentRequestErrorCode,
} from "@app/types/collab";
import {
  collabTokenSchema,
  commentClientMessageSchema,
  EPOCH_CHANGED_CLOSE_REASON,
  isDefaultSaveState,
  parseSessionName,
} from "@app/types/collab";
import type { Result } from "@app/types/shared/result";
import { Err } from "@app/types/shared/result";
import { normalizeError } from "@app/types/shared/utils/error_utils";
import { safeParseJSON } from "@app/types/shared/utils/json_utils";
import {
  authenticateConnection,
  RESET_CONNECTION,
} from "@front-api/collab/lib/connection_access";
import type { CollabSession } from "@front-api/collab/lib/session";
import {
  epochMessage,
  getSession,
  recordSaveResult,
  saveSession,
  saveStateMessage,
  storeSessionState,
  toSaveState,
  serverMessage,
  showAgentActivity,
  startSession,
  stopWrites,
} from "@front-api/collab/lib/session";
import type { Document, LocalTransactionOrigin } from "@hocuspocus/server";
import { Hocuspocus } from "@hocuspocus/server";

import { z } from "zod";

export const UNLOAD_GRACE_PERIOD_MS = 5 * 60 * 1000;
export const COMMENT_COMMAND_TIMEOUT_MS = 30 * 1000;
// Each store serializes and uploads the whole `.md`, its only durable copy for now: a crash loses up
// to `STORE_MAX_DEBOUNCE_MS` plus `STORE_DEBOUNCE_MS` of edits; a shutdown saves them first.
const STORE_DEBOUNCE_MS = 5 * 1000;
const STORE_MAX_DEBOUNCE_MS = 30 * 1000;

// Only the reason reaches the browser.
const EPOCH_CHANGED = {
  code: RESET_CONNECTION.code,
  reason: EPOCH_CHANGED_CLOSE_REASON,
};

/**
 * A connection's access, and the epoch of the document its browser kept from an earlier
 * connection, absent when it kept none.
 */
export type CollabContext = CollabAccess & { keptEpoch?: string };

/** A token is a ticket alone, or a `CollabToken` from a browser that kept its document. */
function parseToken(token: string): { ticket: string; keptEpoch?: string } {
  const json = safeParseJSON(token);
  const parsed = json.isOk() ? collabTokenSchema.safeParse(json.value) : null;
  return parsed?.success
    ? { ticket: parsed.data.ticket, keptEpoch: parsed.data.epoch }
    : { ticket: token };
}

const refusedMessage = (requestId: string, error: CommentRequestErrorCode) =>
  serverMessage({ type: "refused", requestId, error });

type CommandResult = Awaited<ReturnType<typeof applyCommentRequest>>;

// The comment marks the session places are no connection's change: saves go through whoever last
// changed the text, and a commenter may not be able to write.
const COMMENT_MARK_ORIGIN: LocalTransactionOrigin = { source: "local" };

const commandRequestSchema = z.object({
  type: z.literal("command"),
  requestId: z.string().min(1),
});

/** A save failure is an error once, then each retry that fails again only a warning. */
function logSaveFailure(
  retries: number,
  fields: Record<string, unknown>,
  message: string
): void {
  if (retries === 0) {
    logger.error({ ...fields, retries }, message);
  } else {
    logger.warn({ ...fields, retries }, message);
  }
}

/** Logs why a connection or a load is refused, then rejects it the way Hocuspocus expects. */
function refuse(documentName: string, reason: string): never {
  logger.warn({ documentName, reason }, "Collab connection refused");
  throw new Error(reason);
}

/** Logs an unexpected failure, which Hocuspocus would swallow, then rethrows it. */
function logUnexpected(
  { documentName, workspaceId }: { documentName: string; workspaceId: string },
  message: string
) {
  return (err: unknown): never => {
    logger.error(
      { err: normalizeError(err), documentName, workspaceId },
      message
    );
    throw err;
  };
}

/**
 * @cc [owner:PopDaph,label:error-handling] hocuspocus-hook-protocol
 * These hooks follow Hocuspocus's protocol, an exception to `no-catching-own-errors` and
 * `no-parameter-mutation` limited to them: a hook MUST reject a connection, a load or a store by
 * throwing, MUST make a connection read-only by setting `connectionConfig.readOnly`, and
 * `onLoadDocument` MUST destroy the document it was handed when the load fails, since Hocuspocus
 * does not. Hocuspocus swallows what the hooks throw, so every refusal and failure MUST be logged
 * first, without the token.
 */
/**
 * @cc [owner:PopDaph;tdraier,label:product;concurrency] collab-document-lifecycle
 * Every load MUST go through `loadCollabSession`, and once loaded, the document MUST be stored with
 * `storeSessionState` when the load asks it (`shouldStoreState`). Every connection MUST be sent the
 * session's epoch once connected. A store MUST save the document with the session's threads and
 * last save, through the connection that last changed it, and MUST fail when that connection
 * cannot write or the save fails, so Hocuspocus keeps the document instead of unloading it. Once
 * the save has finished, failed or not, the session's state MUST be stored with
 * `storeSessionState`, which the store MUST NOT wait for; a store with no writer, or one that
 * cannot write, stores none. When the
 * load returned edits its file lacks (`hasUnsavedEdits`) and nobody changed the document since,
 * the first connection that can write MUST become its writer once connected, and the document
 * MUST be stored. Once its last WebSocket client leaves,
 * the document MUST stay loaded for `UNLOAD_GRACE_PERIOD_MS` after that departure, then unload
 * unless a connection is open or its last save failed. A direct connection that leaves
 * during that period does not extend it. A failed save MUST be retried after
 * `SAVE_RETRY_DELAY_MS`, the delay doubling with each retry up to `SAVE_RETRY_MAX_DELAY_MS`, until
 * one succeeds, the document unloads or `saveAllSessions` is called, except a save whose writer
 * cannot write, which only another edit fixes. Every time the session's save state
 * (`toSaveState`) changes, every connection MUST be sent it as `save_state`, and a connection
 * opening while it differs from `DEFAULT_SAVE_STATE` MUST be sent it once connected. The state
 * includes the last copy kept after a save conflict (`collab-session-save-conflict`).
 */
/**
 * @cc [owner:PopDaph,label:product] collab-kept-epoch
 * A connection MUST authenticate with its ticket alone, or with a `CollabToken` carrying the epoch
 * of the document its browser kept. A connection whose epoch differs from its document's MUST be
 * closed with `EPOCH_CHANGED_CLOSE_REASON` before any of its sync messages is applied, so a kept
 * document never merges into another Yjs history. A connection with no epoch, or with its
 * document's, MUST sync as before.
 */
export function createCollabHocuspocus(): Hocuspocus<CollabContext> {
  const hocuspocus = new Hocuspocus<CollabContext>({
    debounce: STORE_DEBOUNCE_MS,
    maxDebounce: STORE_MAX_DEBOUNCE_MS,

    // The ticket is minted by front-api for this user, workspace and file.
    async onAuthenticate({ documentName, token, connectionConfig }) {
      const parsed = parseSessionName(documentName);
      if (!parsed) {
        refuse(documentName, "Invalid document name.");
      }
      const { ticket, keptEpoch } = parseToken(token);
      const file = await authenticateConnection(parsed, ticket).catch(
        logUnexpected(
          { documentName, workspaceId: parsed.workspaceId },
          "Collab authentication failed"
        )
      );
      if (file.isErr()) {
        refuse(documentName, file.error);
      }
      connectionConfig.readOnly = !file.value.canWrite;
      return { ...file.value, keptEpoch };
    },

    // A kept document of another Yjs history would merge as a second copy of its text.
    async beforeSync({ context, document, documentName }) {
      const session = getSession(document);
      if (
        !session ||
        context.keptEpoch === undefined ||
        context.keptEpoch === session.epoch
      ) {
        return;
      }
      logger.info(
        {
          documentName,
          workspaceId: context.workspaceId,
          keptEpoch: context.keptEpoch,
          epoch: session.epoch,
        },
        "Collab sync refused: the kept document has another epoch"
      );
      // Hocuspocus closes the connection with the `code` and `reason` of what the hook throws.
      throw Object.assign(new Error(EPOCH_CHANGED.reason), EPOCH_CHANGED);
    },

    async onLoadDocument({ context, document, documentName }) {
      let loaded: Awaited<ReturnType<typeof loadCollabSession>>;
      try {
        loaded = await loadCollabSession(context);
      } catch (err) {
        document.destroy();
        return logUnexpected(
          { documentName, workspaceId: context.workspaceId },
          "Collab document load failed"
        )(err);
      }
      if (loaded.isErr()) {
        document.destroy();
        refuse(documentName, loaded.error);
      }
      const { content, lastSave, epoch, hasUnsavedEdits, shouldStoreState } =
        loaded.value;
      startSession(document, {
        comments: content.comments,
        lastSave,
        epoch,
        loadedEditsNeedWriter: hasUnsavedEdits,
        loadedStateNeedsStore: shouldStoreState,
        pendingStateStore: undefined,
        stateStoreRequested: false,
        saveFailed: false,
        saveRetryTimer: undefined,
        saveRetries: 0,
        conflictCopy: undefined,
        lastChangedBy: undefined,
        lastCommenter: undefined,
        graceTimer: undefined,
        pendingMutations: Promise.resolve(),
      });
      return content.doc;
    },

    // The document only holds the loaded state from here on.
    async afterLoadDocument({ document }) {
      const session = getSession(document);
      if (session?.loadedStateNeedsStore) {
        session.loadedStateNeedsStore = false;
        storeSessionState(document);
      }
    },

    async onChange({ document, context, transactionOrigin }) {
      const session = getSession(document);
      if (session && transactionOrigin !== COMMENT_MARK_ORIGIN) {
        session.lastChangedBy = context;
        session.loadedEditsNeedWriter = false;
      }
    },

    // TODO(co-edition): this writes the `.md` on every debounced store, about every 5 to 30 seconds
    // while people type. LIVE_SESSION.md keeps the Yjs state in a durable store between
    // saves instead, since each write is a new file revision that agents' conditional
    // writes conflict with.
    async onStoreDocument({ document, documentName, instance }) {
      const session = getSession(document);
      // Not `lastContext`: a direct connection's disconnect stores the document with its own
      // context, even when it changed nothing.
      const writer = session?.lastChangedBy ?? session?.lastCommenter;
      if (!session || !writer) {
        return;
      }
      if (writer.canWrite !== true) {
        logSaveFailure(
          session.saveRetries,
          { documentName, workspaceId: writer.workspaceId },
          "Collab document changed without a writer"
        );
        // A retry would save through the same writer: only an edit from one who can write fixes it.
        recordSaveResult(instance, document, "failed_until_edited");
        throw new Error("The document was changed without a writer.");
      }

      let saved: Awaited<ReturnType<typeof saveSession>>;
      try {
        saved = await saveSession(document, writer);
      } catch (err) {
        logSaveFailure(
          session.saveRetries,
          {
            err: normalizeError(err),
            documentName,
            workspaceId: writer.workspaceId,
          },
          "Collab save failed"
        );
        recordSaveResult(instance, document, "failed");
        // A save never waits for Redis. The stored state then keeps the edits the file lacks.
        storeSessionState(document);
        throw err;
      }
      if (saved.isErr()) {
        logSaveFailure(
          session.saveRetries,
          {
            documentName,
            workspaceId: writer.workspaceId,
            reason: saved.error.message,
            code: saved.error.code,
            bodyReason: getYDocUnsavableBodyReason(
              { doc: document, comments: session.comments },
              saved.error.message
            ),
          },
          "Collab save failed"
        );
        recordSaveResult(instance, document, "failed");
        storeSessionState(document);
        throw new Error(saved.error.message);
      }
      session.lastSave = saved.value;
      recordSaveResult(instance, document, "saved");
      storeSessionState(document);
    },

    async onDisconnect({ instance, document }) {
      const session = getSession(document);
      if (!session || document.getConnections().length > 0) {
        return;
      }
      // Holding the document as a direct connection keeps Hocuspocus from unloading it.
      // TODO(co-edition): the hold inflates the connection counts Hocuspocus reports, and a store
      // that finishes between the last connection's removal and this hook unloads the document
      // with no grace period. Vetoing the unload from `beforeUnloadDocument` until the period ends
      // would cover every unload path.
      if (session.graceTimer === undefined) {
        document.addDirectConnection();
      }
      clearTimeout(session.graceTimer);
      session.graceTimer = setTimeout(() => {
        session.graceTimer = undefined;
        document.removeDirectConnection();
        // Unloading would drop the edits the file does not have. The retried save unloads it once
        // it succeeds, with no grace period left.
        if (!session.saveFailed) {
          void instance.unloadDocument(document);
        }
      }, UNLOAD_GRACE_PERIOD_MS);
    },

    // A connection joining while saves fail learns it here, the others when it changes.
    async connected({ connection, context, documentName, instance }) {
      const { document } = connection;
      const session = getSession(document);
      if (!session) {
        return;
      }
      connection.sendStateless(epochMessage(session.epoch));
      const state = toSaveState(session);
      if (!isDefaultSaveState(state)) {
        connection.sendStateless(saveStateMessage(state));
      }
      if (session.loadedEditsNeedWriter && context.canWrite) {
        session.loadedEditsNeedWriter = false;
        session.lastChangedBy = context;
        // Not awaited: Hocuspocus debounces the store and catches its failures, which
        // `onStoreDocument` logs.
        void instance.storeDocumentHooks(document, {
          clientsCount: document.getConnectionsCount(),
          document,
          documentName,
          instance,
          lastContext: context,
          lastTransactionOrigin: undefined,
        });
      }
    },

    async onStateless({ connection, document, payload }) {
      void handleClientMessage(hocuspocus, {
        document,
        file: connection.context,
        payload,
        reply: (message) => connection.sendStateless(message),
      });
    },
  });

  return hocuspocus;
}

/** A comment command waiting for its turn, with how to answer it. */
interface QueuedCommand {
  hocuspocus: Hocuspocus<CollabAccess>;
  document: Document;
  session: CollabSession;
  file: CollabAccess;
  requestId: string;
  command: CommentRequest;
  deadline: number;
  answer: (message: string) => void;
}

function logCommandFailure({ document, file }: QueuedCommand, err: unknown) {
  logger.error(
    {
      err: normalizeError(err),
      documentName: document.name,
      workspaceId: file.workspaceId,
    },
    "Collab comment command failed"
  );
}

async function applyCommand(queued: QueuedCommand): Promise<CommandResult> {
  const { document, session, file, command, deadline } = queued;
  const remaining = deadline - Date.now();
  try {
    const applied =
      remaining > 0
        ? await Promise.race([
            applyCommentRequest(file, session.comments, command),
            setTimeoutAsync(remaining),
          ])
        : "timeout";
    if (applied === "timeout") {
      logger.error(
        { documentName: document.name, workspaceId: file.workspaceId },
        "Collab comment command timed out"
      );
      return new Err("unavailable");
    }
    return applied;
  } catch (err) {
    logCommandFailure(queued, err);
    return new Err("unavailable");
  }
}

async function dispatchMentions(
  { hocuspocus, document, file, command }: QueuedCommand,
  added: DfmMessage
): Promise<void> {
  try {
    await dispatchSessionCommentMentions(
      file,
      document,
      command,
      added,
      (agent, activity) =>
        showAgentActivity(hocuspocus, document.name, agent, activity)
    );
  } catch (err) {
    logger.error(
      {
        err: normalizeError(err),
        documentName: document.name,
        workspaceId: file.workspaceId,
      },
      "Collab comment mentions dispatch failed"
    );
  }
}

async function runCommand(queued: QueuedCommand): Promise<void> {
  const { hocuspocus, document, session, file, requestId, command, answer } =
    queued;
  // Unloaded while the command waited or ran: a reload reads the file into a new document,
  // and storing this one would cancel that document's debounced store, keyed by name.
  // While saves fail, an accepted comment would only live in memory.
  const result: CommandResult =
    document.isDestroyed || session.saveFailed
      ? new Err("unavailable")
      : await applyCommand(queued);
  if (document.isDestroyed || result.isErr()) {
    answer(
      refusedMessage(requestId, result.isErr() ? result.error : "unavailable")
    );
    return;
  }

  if (command.type === "add" && command.anchor) {
    let anchored: Result<void, CommentRequestErrorCode>;
    try {
      anchored = anchorYDocComment(
        document,
        {
          commentId: command.commentId,
          anchor: command.anchor,
          comments: result.value.comments,
        },
        COMMENT_MARK_ORIGIN
      );
    } catch (err) {
      logCommandFailure(queued, err);
      anchored = new Err("unavailable");
    }
    if (anchored.isErr()) {
      answer(refusedMessage(requestId, anchored.error));
      return;
    }
    // The mark first, so editors already hold it when the thread arrives.
    document.flush();
  }

  // TODO(co-edition): a command still applies after its sender left, whose channel already
  // answered it `unavailable`; a retried `add` then makes a second thread.
  session.comments = result.value.comments;
  // Every accepted command changes the threads.
  session.lastCommenter = file;
  // TODO(co-edition): broadcast only the changed thread rather than every thread to every
  // connection.
  document.broadcastStateless(
    serverMessage({ type: "threads", comments: session.comments })
  );
  answer(
    serverMessage({
      type: "accepted",
      requestId,
      comment: result.value.created,
    })
  );
  // Not awaited: Hocuspocus debounces the store and catches its failures, which
  // `onStoreDocument` logs.
  void hocuspocus.storeDocumentHooks(document, {
    clientsCount: document.getConnectionsCount(),
    document,
    documentName: document.name,
    instance: hocuspocus,
    lastContext: file,
    lastTransactionOrigin: undefined,
  });
  const { added } = result.value;
  if (added) {
    // Not awaited: the command is answered without waiting for its mentions to be posted.
    void dispatchMentions(queued, added);
  }
}

/**
 * @cc [owner:PopDaph;tdraier,label:security;product] collab-comment-threads
 * `file` MUST be the sending connection's access, and `reply` the only way back to it. A threads
 * request MUST get the session's threads. A command MUST be applied with `applyCommentRequest`, one
 * at a time per document, and always answered: `accepted`, refused with its error, or
 * `unavailable` when invalid, thrown, late (`COMMENT_COMMAND_TIMEOUT_MS`), or after its document
 * unloaded or its last save failed. A refused command changes nothing, unless it threw midway, and
 * never holds later ones.
 * An anchored `add` MUST first mark its text (`anchorYDocComment`, as no connection's change, never
 * saved through), the mark reaching every connection before the threads. Once accepted, the threads
 * MUST go to every connection and the document be stored, saved through its last text editor or
 * else the latest commenter, then `dispatchSessionCommentMentions` started without waiting. Other
 * messages MUST be ignored. A throwing `reply`, a command throwing before its answer and a failed
 * dispatch MUST only be logged (exceptions to `no-catching-own-errors`). The promise MUST resolve
 * once answered or ignored, never reject.
 */
export async function handleClientMessage(
  hocuspocus: Hocuspocus<CollabAccess>,
  {
    document,
    file,
    payload,
    reply,
  }: {
    document: Document;
    file: CollabAccess;
    payload: string;
    reply: (message: string) => void;
  }
): Promise<void> {
  const session = getSession(document);
  const { name: documentName } = document;
  let answered = false;
  const answer = (message: string) => {
    answered = true;
    try {
      reply(message);
    } catch (err) {
      logger.error(
        {
          err: normalizeError(err),
          documentName,
          workspaceId: file.workspaceId,
        },
        "Collab comment answer not sent"
      );
    }
  };
  const json = safeParseJSON(payload);
  const message = json.isOk()
    ? commentClientMessageSchema.safeParse(json.value)
    : null;
  if (!session || !message?.success) {
    logger.info(
      { documentName, workspaceId: file.workspaceId },
      "Collab stateless message ignored"
    );
    const request = json.isOk()
      ? commandRequestSchema.safeParse(json.value)
      : null;
    if (request?.success) {
      answer(refusedMessage(request.data.requestId, "unavailable"));
    }
    return;
  }
  if (message.data.type === "threads") {
    answer(serverMessage({ type: "threads", comments: session.comments }));
    return;
  }

  const queued: QueuedCommand = {
    hocuspocus,
    document,
    session,
    file,
    requestId: message.data.requestId,
    command: message.data.command,
    // From its arrival: a command waiting behind others is as late as one that runs long.
    deadline: Date.now() + COMMENT_COMMAND_TIMEOUT_MS,
    answer,
  };
  const previous = session.pendingMutations;
  // Never rejects: a command that fails fails alone, not the writes and commands queued after it.
  const handle = async (): Promise<void> => {
    try {
      await previous;
      await runCommand(queued);
    } catch (err) {
      logCommandFailure(queued, err);
      if (!answered) {
        answer(refusedMessage(queued.requestId, "unavailable"));
      }
    }
  };
  session.pendingMutations = handle();
  await session.pendingMutations;
}

/**
 * @cc [owner:PopDaph,label:product;concurrency] collab-shutdown-save
 * Once no connection can send edits any more, every document MUST be saved at once, in
 * place of its pending debounced store, including documents still loading, which are waited for
 * first. From the call on, `writeSessionSource` and `editSessionSource` MUST answer `busy`, and the
 * writes, edits and comment commands already queued MUST finish before the saves. The returned
 * promise MUST resolve only once each save has finished or failed, then each state write pending
 * (`storeSessionState`) has been answered, or `YDOC_STATE_TIMEOUT_MS` has passed.
 */
export async function saveAllSessions(
  hocuspocus: Hocuspocus<CollabAccess>
): Promise<void> {
  stopWrites(hocuspocus);
  // A load may still apply edits queued while it ran; its failure was already logged.
  for (const loading of [...hocuspocus.loadingDocuments.values()]) {
    await loading.catch(() => undefined);
  }
  const documents = [...hocuspocus.documents.values()];
  // Their writes only reach the file through the saves below.
  await Promise.all(
    documents.map((document) => getSession(document)?.pendingMutations)
  );
  await concurrentExecutor(
    documents,
    (document) =>
      hocuspocus.storeDocumentHooks(
        document,
        {
          clientsCount: document.getConnectionsCount(),
          document,
          documentName: document.name,
          instance: hocuspocus,
          // The store hook saves through the last writer it recorded, not this context.
          lastContext: undefined,
          lastTransactionOrigin: undefined,
        },
        true
      ),
    { concurrency: 8 }
  );
  // After every save, so none waits for Redis, and bounded: a write Redis never answers would
  // hold the stop.
  const stored = await raceWithTimeout(
    concurrentExecutor(
      documents,
      async (document) => {
        await getSession(document)?.pendingStateStore;
      },
      { concurrency: 8 }
    ),
    YDOC_STATE_TIMEOUT_MS
  );
  if (stored === "timeout") {
    logger.warn(
      { documentsCount: documents.length },
      "Collab document states not stored before stopping"
    );
  }
}
