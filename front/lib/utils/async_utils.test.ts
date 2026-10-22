import {
  raceWithTimeout,
  withPeriodicHeartbeat,
} from "@app/lib/utils/async_utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("withPeriodicHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires heartbeatFn periodically while fn is pending", async () => {
    const heartbeatFn = vi.fn();
    let resolveFn: (value: string) => void = () => {};

    const promise = withPeriodicHeartbeat(
      () =>
        new Promise<string>((resolve) => {
          resolveFn = resolve;
        }),
      { intervalMs: 10_000, heartbeatFn }
    );

    // A stall longer than the 60s Temporal heartbeat timeout keeps heartbeating.
    await vi.advanceTimersByTimeAsync(65_000);
    expect(heartbeatFn).toHaveBeenCalledTimes(6);

    resolveFn("done");
    await expect(promise).resolves.toBe("done");
  });

  it("stops heartbeating once fn resolves", async () => {
    const heartbeatFn = vi.fn();

    const promise = withPeriodicHeartbeat(() => Promise.resolve(42), {
      intervalMs: 10_000,
      heartbeatFn,
    });

    await expect(promise).resolves.toBe(42);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatFn).not.toHaveBeenCalled();
  });

  it("stops heartbeating when fn rejects", async () => {
    const heartbeatFn = vi.fn();

    const promise = withPeriodicHeartbeat(
      () => Promise.reject(new Error("boom")),
      { intervalMs: 10_000, heartbeatFn }
    );

    await expect(promise).rejects.toThrow("boom");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatFn).not.toHaveBeenCalled();
  });
});

describe("raceWithTimeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns what the promise settles to, clearing its timer", async () => {
    expect(await raceWithTimeout(Promise.resolve("done"), 1000)).toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns timeout when the promise has not settled in time", async () => {
    const racing = raceWithTimeout(new Promise(() => {}), 1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await racing).toBe("timeout");
  });
});
