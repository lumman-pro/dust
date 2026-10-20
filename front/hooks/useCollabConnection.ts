import type {
  CollabConnectionSettings,
  CollabStatus,
} from "@app/components/editor/document/types";
import type { CommentChannel } from "@app/lib/client/collab/comments";
import { createCommentChannel } from "@app/lib/client/collab/comments";
import { onStatelessMessage } from "@app/lib/client/collab/messages";
import type { DfmComment } from "@app/lib/markdown/dfm";
import datadogLogger from "@app/logger/datadogLogger";
import type { SaveState } from "@app/types/collab";
import { DEFAULT_SAVE_STATE, saveStateMessageSchema } from "@app/types/collab";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";

/** A shared document synced with the server, and the connection that keeps it in sync. */
export interface CollabConnection {
  /** Unique per connection: an editor bound to one never outlives it. */
  id: number;
  document: Y.Doc;
  provider: HocuspocusProvider;
  comments: CommentChannel;
  close: () => void;
}

let nextConnectionId = 0;

const RECONNECT_DELAY_MS = 1_000;
// A deploy restarts the collab pod: retrying every 5 s at most rejoins soon after it is back.
const MAX_RECONNECT_DELAY_MS = 5_000;
// A refusal (no access, formatting the editor cannot keep) gets the same answer until that changes.
const REFUSED_RETRY_DELAY_MS = 30_000;

/**
 * The wait before the next attempt, after `failures` losses since the last sync: 1 s doubling up
 * to 5 s, then a random part of it from half to all, so tabs lost together do not retry together.
 */
export function reconnectDelayMs(failures: number, random = Math.random()) {
  const delayMs = Math.min(
    RECONNECT_DELAY_MS * 2 ** failures,
    MAX_RECONNECT_DELAY_MS
  );
  return delayMs / 2 + (delayMs / 2) * random;
}

/** The wait before the next attempt: 30 s after a refusal, the `reconnectDelayMs` backoff otherwise. */
export function nextAttemptDelayMs({
  failures,
  isRefused,
}: {
  failures: number;
  isRefused: boolean;
}) {
  return isRefused ? REFUSED_RETRY_DELAY_MS : reconnectDelayMs(failures);
}

/**
 * @cc [owner:PopDaph,label:product] collab-connection-reconnect
 * A shared document MUST be shown only once it has synced with the server. After a disconnect,
 * or the server closing the document, its connection MUST NOT reconnect: the server may hold
 * another copy of the document by then, and merging the old one into it would duplicate the
 * content. A fresh document and connection MUST take over, and the old document stays on
 * screen, read-only, until the new one has synced. The fresh connection's comments MUST start
 * from the threads last received by an earlier connection to the same document and user, if any.
 * Joining another document, or as another user, MUST close the current connection at once.
 * Attempts MUST wait 1 s after a loss, doubling up to 5 s, each wait randomly shortened by up to
 * half. After the server refuses the connection, or its ticket cannot be fetched, the next attempt
 * MUST wait 30 s instead. A synced connection lost MUST be logged once, and again when a
 * connection syncs after it, with how long it was offline.
 */
export function useCollabConnection(
  live: CollabConnectionSettings | undefined
): {
  connection: CollabConnection | null;
  status: CollabStatus;
  /** Since when the shown connection has changes the server has not confirmed, or null. */
  syncingSinceMs: number | null;
  /** How the server stands saving the document, as it last told the current connection. */
  saveState: SaveState;
} {
  const [connection, setConnection] = useState<CollabConnection | null>(null);
  const [status, setStatus] = useState<CollabStatus>("connecting");
  const [syncingSinceMs, setSyncingSinceMs] = useState<number | null>(null);
  const [saveState, setSaveState] = useState<SaveState>(DEFAULT_SAVE_STATE);
  const [attempt, setAttempt] = useState(0);
  const shownRef = useRef<CollabConnection | null>(null);
  // Losses since the last sync: the delay doubles with each, so a down server is not hammered.
  const failuresRef = useRef(0);
  // When the last synced connection was lost, until a fresh one syncs.
  const lostAtMsRef = useRef<number | null>(null);
  // TODO(co-edition): the threads also live in the channel and the editor; one store per session,
  // outliving its connections, would replace this copy taken before each close.
  const lastThreadsRef = useRef<DfmComment[] | null>(null);

  const url = live?.url;
  const documentName = live?.documentName;
  const userId = live?.user.id;
  const getTicket = live?.getTicket;

  // Another document or user: what is shown belongs to the previous one.
  useEffect(
    () => () => {
      shownRef.current?.close();
      shownRef.current = null;
      failuresRef.current = 0;
      lostAtMsRef.current = null;
      lastThreadsRef.current = null;
      setConnection(null);
      setStatus("connecting");
      setSyncingSinceMs(null);
      setSaveState(DEFAULT_SAVE_STATE);
    },
    [url, documentName, userId, getTicket]
  );

  useEffect(() => {
    if (
      url === undefined ||
      documentName === undefined ||
      getTicket === undefined
    ) {
      return;
    }
    const document = new Y.Doc();
    let synced = false;
    // Disconnected: no more updates. Destroyed: the document is gone too.
    let closed = false;
    let destroyed = false;
    let refused = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let comments: CommentChannel | null = null;
    let stopSaveState = () => {};
    const close = () => {
      if (destroyed) {
        return;
      }
      destroyed = true;
      stopSaveState();
      comments?.close();
      if (!closed) {
        closed = true;
        provider.destroy();
      }
      document.destroy();
    };
    // The provider's own retry outlives its destroy, so a fresh one always takes over instead.
    const onLost = () => {
      if (closed) {
        return;
      }
      closed = true;
      lastThreadsRef.current = comments?.getThreads() ?? lastThreadsRef.current;
      stopSaveState();
      comments?.close();
      provider.destroy();
      if (synced) {
        setStatus("offline");
        setSyncingSinceMs(null);
        lostAtMsRef.current = performance.now();
        datadogLogger.info("Collab connection lost");
      }
      // The next connection is told again if saves still fail: a connection lost before it synced
      // may have been told they failed, and no one tells it once they recover.
      setSaveState(DEFAULT_SAVE_STATE);
      const delayMs = nextAttemptDelayMs({
        failures: failuresRef.current,
        isRefused: refused,
      });
      failuresRef.current++;
      retry = setTimeout(() => setAttempt((current) => current + 1), delayMs);
    };
    const provider = new HocuspocusProvider({
      url,
      name: documentName,
      token: getTicket,
      document,
      onSynced: ({ state }) => {
        if (!state || synced || closed) {
          return;
        }
        synced = true;
        if (lostAtMsRef.current !== null) {
          datadogLogger.info(
            {
              offlineMs: Math.round(performance.now() - lostAtMsRef.current),
              attempts: failuresRef.current,
            },
            "Collab connection restored"
          );
          lostAtMsRef.current = null;
        }
        failuresRef.current = 0;
        comments = createCommentChannel(provider, lastThreadsRef.current);
        const next = {
          id: nextConnectionId++,
          document,
          provider,
          comments,
          close,
        };
        shownRef.current = next;
        setConnection(next);
        setStatus("live");
        setSyncingSinceMs(provider.hasUnsyncedChanges ? Date.now() : null);
      },
      onUnsyncedChanges: ({ number }) => {
        if (synced && !closed) {
          setSyncingSinceMs((since) =>
            number > 0 ? (since ?? Date.now()) : null
          );
        }
      },
      onDisconnect: onLost,
      // Also sent alone, without a disconnect, when the server closes the document.
      onClose: onLost,
      // A refused connection or an unfetchable ticket: retried slowly, access may come back.
      onAuthenticationFailed: () => {
        refused = true;
        setStatus("refused");
        onLost();
      },
    });

    // Listening before the connection opens: the server tells a connection joining while saves
    // fail as soon as it is connected, before it has synced.
    stopSaveState = onStatelessMessage(
      provider,
      saveStateMessageSchema,
      ({ type: _type, ...state }) => setSaveState(state)
    );

    return () => {
      clearTimeout(retry);
      // The shown connection outlives its effect: it closes once replaced, or on unmount.
      if (shownRef.current?.provider !== provider) {
        close();
      }
    };
  }, [url, documentName, userId, getTicket, attempt]);

  // Closed after the swap has rendered, so no editor is left bound to a destroyed document.
  useEffect(() => {
    return () => connection?.close();
  }, [connection]);

  return { connection, status, syncingSinceMs, saveState };
}
