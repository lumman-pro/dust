import type { PreFetchedFile } from "@viz/app/lib/data-apis/cache-data-api";
import { getVizCatalog } from "@viz/app/lib/i18n/catalogs";
import type { FileRef } from "@viz/app/lib/parseFileRefs";
import { cloneResponse } from "next/dist/server/lib/clone-response";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSideVisualizationWrapper } from "./ServerVisualizationWrapper";

const mocks = vi.hoisted(() => ({
  extractFileRefs: vi.fn<(text: string) => FileRef[]>(),
}));

vi.mock("@viz/app/lib/parseFileRefs", () => ({
  extractFileRefs: mocks.extractFileRefs,
}));

vi.mock("@viz/app/content/ServerVisualizationWrapperClient", () => ({
  ServerVisualizationWrapperClient: () => null,
}));

const MB = 1024 * 1024;

function streamedBody(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function createByteTracker() {
  let liveBytes = 0;
  let peakLiveBytes = 0;
  return {
    add(bytes: number) {
      liveBytes += bytes;
      peakLiveBytes = Math.max(peakLiveBytes, liveBytes);
    },
    release(bytes: number) {
      liveBytes -= bytes;
    },
    get peakLiveBytes() {
      return peakLiveBytes;
    },
  };
}

function trackedChunkedBody(
  bytes: number,
  tracker: ReturnType<typeof createByteTracker>,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  let pulledBytes = 0;
  let abort: (() => void) | undefined;
  return new ReadableStream({
    start(controller) {
      abort = () => {
        tracker.release(pulledBytes);
        controller.error(signal?.reason);
      };
      signal?.addEventListener("abort", abort, { once: true });
    },
    pull(controller) {
      if (pulledBytes === bytes) {
        if (abort) {
          signal?.removeEventListener("abort", abort);
        }
        controller.close();
        return;
      }
      const chunkBytes = Math.min(MB, bytes - pulledBytes);
      pulledBytes += chunkBytes;
      tracker.add(chunkBytes);
      controller.enqueue(new Uint8Array(chunkBytes));
    },
    cancel() {
      tracker.release(pulledBytes);
    },
  });
}

type ResponseFactory = (signal?: AbortSignal) => Response | Promise<Response>;

function stubFetch(
  files: Record<string, ResponseFactory>,
  code: ResponseFactory = () => Response.json({ content: "frame code" })
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const signal = init?.signal ?? undefined;
      if (url.endsWith("/api/v1/viz/content")) {
        return code(signal);
      }
      const fileId = url.split("/").pop() ?? "";
      return files[fileId]?.(signal) ?? new Response(null, { status: 404 });
    })
  );
}

async function renderPrefetchedFiles(): Promise<PreFetchedFile[]> {
  const element = await ServerSideVisualizationWrapper({
    accessToken: "token",
    allowedOrigins: [],
    identifier: "viz-1",
    frameProps: {},
    catalog: getVizCatalog("en-US"),
  });
  return element?.props.prefetchedFiles ?? [];
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("ServerSideVisualizationWrapper prefetch budget", () => {
  it("skips a file whose declared size exceeds the per-file limit", async () => {
    mocks.extractFileRefs.mockReturnValue([
      { type: "fileId", fileId: "fil_small" },
      { type: "fileId", fileId: "fil_large" },
    ]);
    stubFetch({
      fil_small: () => new Response(new Uint8Array(1024)),
      fil_large: () =>
        new Response(streamedBody(1024), {
          headers: { "content-length": String(21 * MB) },
        }),
    });

    const files = await renderPrefetchedFiles();

    expect(files.map((f) => f.fileId)).toEqual(["fil_small"]);
  });

  it("skips a streamed file without content-length once it exceeds the per-file limit", async () => {
    mocks.extractFileRefs.mockReturnValue([
      { type: "fileId", fileId: "fil_streamed" },
    ]);
    stubFetch({
      fil_streamed: () => new Response(streamedBody(21 * MB)),
    });

    const files = await renderPrefetchedFiles();

    expect(files).toEqual([]);
  });

  it("aborts reads that would exceed the total budget and keeps only files that fit", async () => {
    const fileIds = ["fil_1", "fil_2", "fil_3", "fil_4"];
    mocks.extractFileRefs.mockReturnValue(
      fileIds.map((fileId): FileRef => ({ type: "fileId", fileId }))
    );
    const tracker = createByteTracker();
    stubFetch(
      Object.fromEntries(
        fileIds.map((fileId) => [
          fileId,
          (signal?: AbortSignal) =>
            new Response(trackedChunkedBody(19 * MB, tracker, signal)),
        ])
      )
    );

    const files = await renderPrefetchedFiles();

    expect(files).toHaveLength(2);
    // Allows one read-ahead chunk per concurrent stream plus the chunk that crosses the budget.
    expect(tracker.peakLiveBytes).toBeLessThanOrEqual(55 * MB);
  });
});

// Model a fetch whose body stays open until the network request is aborted. In particular,
// cancelling one branch of cloneResponse's tee does not close this source.
function pendingBody(signal: AbortSignal | undefined, bytes = 0) {
  const aborted = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener(
        "abort",
        () => {
          aborted();
          controller.error(signal.reason);
        },
        { once: true }
      );
      if (bytes > 0) {
        controller.enqueue(new Uint8Array(bytes));
      }
    },
  });
  return { body, aborted };
}

describe("ServerSideVisualizationWrapper fetch lifetime", () => {
  it.each([
    { kind: "declared", contentLength: String(21 * MB), bytes: 1024 },
    { kind: "streamed", contentLength: undefined, bytes: 21 * MB },
  ])(
    "aborts a $kind oversized source even when its response is teed",
    async ({ contentLength, bytes }) => {
      mocks.extractFileRefs.mockReturnValue([
        { type: "fileId", fileId: "fil_large" },
      ]);
      const sources: ReturnType<typeof pendingBody>[] = [];
      const memoizedResponses: Response[] = [];
      stubFetch({
        fil_large: (signal) => {
          const source = pendingBody(signal, bytes);
          sources.push(source);
          const headers = contentLength
            ? { "content-length": contentLength }
            : undefined;
          // Use Next's actual tee helper, with the second branch kept unread.
          const [response, memoized] = cloneResponse(
            new Response(source.body, { headers })
          );
          memoizedResponses.push(memoized);
          return response;
        },
      });

      expect(await renderPrefetchedFiles()).toEqual([]);
      expect(sources[0].aborted).toHaveBeenCalledOnce();
      await expect(
        memoizedResponses[0].body?.getReader().read()
      ).rejects.toThrow();
    }
  );

  it("aborts unread HTTP error bodies", async () => {
    mocks.extractFileRefs.mockReturnValue([
      { type: "fileId", fileId: "fil_error" },
    ]);
    const sources: ReturnType<typeof pendingBody>[] = [];
    stubFetch({
      fil_error: (signal) => {
        const source = pendingBody(signal);
        sources.push(source);
        return new Response(source.body, { status: 503 });
      },
    });

    expect(await renderPrefetchedFiles()).toEqual([]);
    expect(sources[0].aborted).toHaveBeenCalledOnce();
  });

  it("releases bytes from failed reads so later files can use the full budget", async () => {
    const failedIds = [
      "fil_failed_1",
      "fil_failed_2",
      "fil_failed_3",
      "fil_failed_4",
    ];
    const acceptedIds = ["fil_good_1", "fil_good_2", "fil_good_3"];
    mocks.extractFileRefs.mockReturnValue(
      [...failedIds, ...acceptedIds].map((fileId): FileRef => ({
        type: "fileId",
        fileId,
      }))
    );
    stubFetch({
      ...Object.fromEntries(
        failedIds.map((fileId) => [
          fileId,
          () => {
            let sent = false;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  if (sent) {
                    controller.error(new Error("Connection reset"));
                  } else {
                    sent = true;
                    controller.enqueue(new Uint8Array(10 * MB));
                  }
                },
              })
            );
          },
        ])
      ),
      fil_good_1: () => new Response(new Uint8Array(19 * MB)),
      fil_good_2: () => new Response(new Uint8Array(19 * MB)),
      fil_good_3: () => new Response(new Uint8Array(12 * MB)),
    });

    const files = await renderPrefetchedFiles();

    expect(files.map((file) => file.fileId).sort()).toEqual(acceptedIds);
  });

  it("aborts code fetching at the render deadline", async () => {
    vi.useFakeTimers();
    const sources: ReturnType<typeof pendingBody>[] = [];
    stubFetch({}, (signal) => {
      const source = pendingBody(signal);
      sources.push(source);
      return new Response(source.body);
    });

    const render = renderPrefetchedFiles();
    await vi.advanceTimersByTimeAsync(20_000);

    expect(await render).toEqual([]);
    expect(sources[0].aborted).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shares the deadline with nested frames, keeps completed files, and skips queued fetches", async () => {
    vi.useFakeTimers();
    mocks.extractFileRefs.mockImplementation((text) =>
      text === "frame code"
        ? [{ type: "fileId", fileId: "fil_frame" }]
        : Array.from({ length: 5 }, (_, i): FileRef => ({
            type: "fileId",
            fileId: `fil_nested_${i}`,
          }))
    );
    const sources: ReturnType<typeof pendingBody>[] = [];
    const queuedFetch = vi.fn(() => new Response("queued"));
    const nestedFile: ResponseFactory = (signal) => {
      const source = pendingBody(signal, 1024);
      sources.push(source);
      return new Response(source.body);
    };
    stubFetch({
      fil_frame: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                new Response("nested frame", {
                  headers: { "content-type": "application/vnd.dust.frame" },
                })
              ),
            19_000
          )
        ),
      fil_nested_0: nestedFile,
      fil_nested_1: nestedFile,
      fil_nested_2: nestedFile,
      fil_nested_3: nestedFile,
      fil_nested_4: queuedFetch,
    });

    const render = renderPrefetchedFiles();
    await vi.advanceTimersByTimeAsync(19_000);
    expect(sources).toHaveLength(4);
    expect(
      sources.every((source) => source.aborted.mock.calls.length === 0)
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect((await render).map((file) => file.fileId)).toEqual(["fil_frame"]);
    for (const source of sources) {
      expect(source.aborted).toHaveBeenCalledOnce();
    }
    expect(queuedFetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("ServerSideVisualizationWrapper nested frames", () => {
  it("prefetches refs of nested frames transitively", async () => {
    const refsByCode: Record<string, FileRef[]> = {
      "frame code": [{ type: "fileId", fileId: "fil_1" }],
      "frame 1 code": [{ type: "fileId", fileId: "fil_2" }],
      "frame 2 code": [{ type: "fileId", fileId: "fil_3" }],
    };
    mocks.extractFileRefs.mockImplementation((text) => refsByCode[text] ?? []);
    const frameResponse = (code: string) =>
      new Response(code, {
        headers: { "content-type": "application/vnd.dust.frame" },
      });
    stubFetch({
      fil_1: () => frameResponse("frame 1 code"),
      fil_2: () => frameResponse("frame 2 code"),
      fil_3: () =>
        new Response("a,b", { headers: { "content-type": "text/csv" } }),
    });

    const files = await renderPrefetchedFiles();

    expect(files.map((f) => f.fileId)).toEqual(["fil_1", "fil_2", "fil_3"]);
    expect(Buffer.from(files[2].data, "base64").toString()).toBe("a,b");
  });
});
