import {
  nextAttemptDelayMs,
  reconnectDelayMs,
  useCollabConnection,
} from "@app/hooks/useCollabConnection";
import type { DfmComment } from "@app/lib/markdown/dfm";
import datadogLogger from "@app/logger/datadogLogger";
import type { Configuration } from "@hocuspocus/server";
import { Server } from "@hocuspocus/server";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DOCUMENT_NAME = "w_1:notes.md";
const USER = { id: "u_1", name: "Daph", color: "#0ea5e9" };
// Stable across renders, as the file panel's is: a new one would start a new connection.
const getTicket = async () => "ticket";

// Hocuspocus reads a port of 0 as none and falls back to 80, so the free port goes through the
// configuration. No signal handlers in tests.
const newServer = (configuration: Partial<Configuration> = {}) =>
  new Server({ quiet: true, port: 0, stopOnSignals: false, ...configuration });

describe("reconnectDelayMs", () => {
  it("doubles from 1 s and stops at 5 s", () => {
    expect(
      [0, 1, 2, 3, 4, 10].map((failures) => reconnectDelayMs(failures, 1))
    ).toEqual([1_000, 2_000, 4_000, 5_000, 5_000, 5_000]);
  });

  it("waits at least half of that, at random", () => {
    expect(reconnectDelayMs(0, 0)).toBe(500);
    expect(reconnectDelayMs(10, 0)).toBe(2_500);
    expect(reconnectDelayMs(10, 0.5)).toBe(3_750);
  });
});

describe("nextAttemptDelayMs", () => {
  it("waits 30 s after a refusal, whatever the failures", () => {
    expect(
      [0, 3, 10].map((failures) =>
        nextAttemptDelayMs({ failures, isRefused: true })
      )
    ).toEqual([30_000, 30_000, 30_000]);
  });

  it("backs off as `reconnectDelayMs` otherwise", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      expect(nextAttemptDelayMs({ failures: 2, isRefused: false })).toBe(4_000);
    } finally {
      random.mockRestore();
    }
  });
});

describe("useCollabConnection", () => {
  let server: Server;

  beforeEach(async () => {
    server = newServer();
    await server.listen();
  });

  afterEach(async () => {
    await server.destroy();
  });

  function renderSession(tickets: () => Promise<string> = getTicket) {
    return renderHook(() =>
      useCollabConnection({
        url: `ws://127.0.0.1:${server.address.port}`,
        documentName: DOCUMENT_NAME,
        getTicket: tickets,
        user: USER,
      })
    );
  }

  it("reports local changes as syncing until the server has them", async () => {
    await server.destroy();
    let hold = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    server = newServer({
      beforeHandleMessage: async () => {
        if (hold) {
          await held;
        }
      },
    });
    await server.listen();
    const { result, unmount } = renderSession();
    await waitFor(() => expect(result.current.status).toBe("live"));
    // Joining sends the provider's own sync messages, confirmed shortly after going live.
    await waitFor(() => expect(result.current.syncingSinceMs).toBeNull());

    hold = true;
    act(() => {
      result.current.connection?.document.getText("body").insert(0, "Hi");
    });

    await waitFor(() => expect(result.current.syncingSinceMs).not.toBeNull());
    // Later changes extend the same wait, so they do not restart its delay.
    const since = result.current.syncingSinceMs;
    act(() => {
      result.current.connection?.document.getText("body").insert(2, "!");
    });
    expect(result.current.syncingSinceMs).toBe(since);
    release();
    await waitFor(() => expect(result.current.syncingSinceMs).toBeNull());
    unmount();
  });

  it("reports the server's save state, sent as soon as it connects", async () => {
    await server.destroy();
    server = newServer({
      connected: async ({ connection }) => {
        connection.sendStateless(
          JSON.stringify({ type: "save_state", failed: true })
        );
      },
    });
    await server.listen();
    const { result, unmount } = renderSession();
    await waitFor(() => expect(result.current.status).toBe("live"));
    expect(result.current.saveState.failed).toBe(true);

    act(() => {
      server.hocuspocus.documents
        .get(DOCUMENT_NAME)
        ?.broadcastStateless(
          JSON.stringify({ type: "save_state", failed: false })
        );
    });
    await waitFor(() => expect(result.current.saveState.failed).toBe(false));
    unmount();
  });

  it("forgets a failed save told to a connection lost before it synced", async () => {
    await server.destroy();
    let connections = 0;
    server = newServer({
      // The first connection hears that saves fail, then drops before syncing; saves recovered
      // by the next one, which hears nothing.
      connected: async ({ connection }) => {
        connections++;
        if (connections === 1) {
          connection.sendStateless(
            JSON.stringify({ type: "save_state", failed: true })
          );
          connection.close();
        }
      },
    });
    await server.listen();
    const { result, unmount } = renderSession();
    await waitFor(() => expect(result.current.status).toBe("live"), {
      timeout: 5000,
    });
    expect(connections).toBe(2);
    expect(result.current.saveState.failed).toBe(false);
    unmount();
  });

  it("takes a fresh connection, with a fresh ticket, when the server closes the document", async () => {
    const tickets = vi.fn(async () => "ticket");
    const { result, unmount } = renderSession(tickets);
    await waitFor(() => expect(result.current.status).toBe("live"));
    const first = result.current.connection;

    server.hocuspocus.closeConnections(DOCUMENT_NAME);

    await waitFor(() => expect(result.current.status).toBe("offline"));
    await waitFor(
      () => {
        expect(result.current.status).toBe("live");
        expect(result.current.connection?.id).not.toBe(first?.id);
      },
      { timeout: 3_000 }
    );
    expect(tickets).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("logs a lost connection once, then how long it was offline when a fresh one syncs", async () => {
    // When each log is sent, to compare with the offline time it reports.
    const loggedAtMs: number[] = [];
    const info = vi
      .spyOn(datadogLogger, "info")
      .mockImplementation(() => loggedAtMs.push(performance.now()));
    try {
      const { result, unmount } = renderSession();
      await waitFor(() => expect(result.current.status).toBe("live"));
      const first = result.current.connection;
      expect(info).not.toHaveBeenCalled();

      server.hocuspocus.closeConnections(DOCUMENT_NAME);

      await waitFor(
        () => expect(result.current.connection?.id).not.toBe(first?.id),
        { timeout: 3_000 }
      );
      expect(info.mock.calls).toEqual([
        ["Collab connection lost"],
        [
          { offlineMs: expect.any(Number), attempts: 1 },
          "Collab connection restored",
        ],
      ]);
      // Offline from the first log to the second, at least the first wait (half of 1 s).
      const elapsedMs = loggedAtMs[1] - loggedAtMs[0];
      expect(elapsedMs).toBeGreaterThanOrEqual(500);
      expect(info.mock.calls[1][0]).toMatchObject({
        offlineMs: expect.toSatisfy(
          (ms: number) => Math.abs(ms - elapsedMs) <= 1
        ),
      });
      unmount();
    } finally {
      info.mockRestore();
    }
  });

  it("starts a fresh connection from the threads the old one last received", async () => {
    const threads: DfmComment[] = [
      {
        id: "c1",
        status: "open",
        messages: [
          {
            author: { kind: "user", id: "usr_daph", name: "Daph" },
            createdAt: "2026-01-01T00:00:00.000Z",
            body: "Why Friday?",
          },
        ],
      },
    ];
    await server.destroy();
    let asked = 0;
    // Answers the first connection only: the fresh one never hears from the server.
    server = newServer({
      async onStateless({ connection }) {
        if (asked++ === 0) {
          connection.sendStateless(
            JSON.stringify({ type: "threads", comments: threads })
          );
        }
      },
    });
    await server.listen();
    const { result, unmount } = renderSession();
    await waitFor(() =>
      expect(result.current.connection?.comments.getThreads()).toEqual(threads)
    );
    const first = result.current.connection;

    server.hocuspocus.closeConnections(DOCUMENT_NAME);

    // Closed as soon as the connection is lost, before a fresh one replaces it: a closed channel
    // reports no threads.
    await waitFor(() => expect(result.current.status).toBe("offline"));
    expect(result.current.connection).toBe(first);
    expect(first?.comments.getThreads()).toBeNull();
    await waitFor(
      () => expect(result.current.connection?.id).not.toBe(first?.id),
      { timeout: 3_000 }
    );
    await waitFor(() => expect(asked).toBe(2));
    const second = result.current.connection;
    expect(second?.comments.getThreads()).toEqual(threads);

    unmount();
    expect(second?.comments.getThreads()).toBeNull();
  });

  // `attempts` counts the connection attempts that reached the refusing step.
  async function expectRetryAfter30Seconds(
    tickets: () => Promise<string>,
    attempts: () => number
  ) {
    // Real time still runs for the sockets; the clock jumps over the wait.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result, unmount } = renderSession(tickets);

      await waitFor(() => expect(result.current.status).toBe("refused"));
      await act(() => vi.advanceTimersByTimeAsync(25_000));
      // Time for an early attempt to open its socket and get refused again.
      await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
      expect(attempts()).toBe(1);
      await act(() => vi.advanceTimersByTimeAsync(5_000));
      await waitFor(() => expect(result.current.status).toBe("live"));
      unmount();
    } finally {
      vi.useRealTimers();
    }
  }

  it("retries 30 s after the server refuses the connection", async () => {
    await server.destroy();
    let authentications = 0;
    server = newServer({
      async onAuthenticate() {
        authentications++;
        if (authentications === 1) {
          throw new Error(
            "The Markdown uses formatting the editor cannot keep."
          );
        }
      },
    });
    await server.listen();

    await expectRetryAfter30Seconds(getTicket, () => authentications);
  });

  it("retries 30 s after the ticket cannot be fetched", async () => {
    const tickets = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("Service unavailable."))
      .mockResolvedValue("ticket");

    await expectRetryAfter30Seconds(tickets, () => tickets.mock.calls.length);
  });

  it("waits longer between attempts while the server stays down", async () => {
    const { port } = server.address;
    await server.destroy();
    const RealWebSocket = globalThis.WebSocket;
    let opened = 0;
    globalThis.WebSocket = class extends RealWebSocket {
      constructor(...args: ConstructorParameters<typeof WebSocket>) {
        super(...args);
        opened++;
      }
    };
    server = newServer();
    // Full waits, without the random shortening: the count below depends on them.
    const random = vi.spyOn(Math, "random").mockReturnValue(1);
    try {
      const { unmount } = renderHook(() =>
        useCollabConnection({
          url: `ws://127.0.0.1:${port}`,
          documentName: DOCUMENT_NAME,
          getTicket,
          user: USER,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 4_500));
      unmount();
    } finally {
      globalThis.WebSocket = RealWebSocket;
      random.mockRestore();
    }

    // Attempts at 0, 1 s and 3 s; a fixed delay would make five.
    expect(opened).toBe(3);
  }, 10_000);
});
