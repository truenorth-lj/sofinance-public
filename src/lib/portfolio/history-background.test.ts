import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { createPortfolioHistoryBackground } from "./history-background";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Portfolio response-deferred history synchronization", () => {
  it("collects without starting work, then runs two jobs and refills freed slots", async () => {
    const queue = createPortfolioHistoryBackground(Date.now() + 60_000);
    const gates = Array.from({ length: 3 }, deferred);
    const calls: number[] = [];
    let active = 0, maximum = 0;
    for (const [index, gate] of gates.entries()) queue.schedule(`bounded-${index}`, async () => {
      calls.push(index); active++; maximum = Math.max(maximum, active);
      await gate.promise; active--;
    });
    expect(calls).toEqual([]);
    const run = queue.run(); await flush();
    expect(calls).toEqual([0, 1]);
    gates[1]!.resolve(); await flush();
    expect(calls).toEqual([0, 1, 2]);
    gates[2]!.resolve(); gates[0]!.resolve(); await run;
    expect(maximum).toBe(2); expect(active).toBe(0);
  });

  it("deduplicates a position across concurrent response callbacks and releases it after success", async () => {
    const first = createPortfolioHistoryBackground(Date.now() + 60_000);
    const second = createPortfolioHistoryBackground(Date.now() + 60_000);
    const gate = deferred(), work = vi.fn(async () => gate.promise);
    first.schedule("same-context", work); second.schedule("same-context", work);
    const a = first.run(), b = second.run(); await flush();
    expect(work).toHaveBeenCalledTimes(1);
    gate.resolve(); await Promise.all([a, b]);
    const next = createPortfolioHistoryBackground(Date.now() + 60_000);
    next.schedule("same-context", work); await next.run();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("gives deferred work an independent live deadline signal after the viewer is gone", async () => {
    const viewer = new AbortController();
    const queue = createPortfolioHistoryBackground(Date.now() + 60_000);
    const work = vi.fn(async (signal: AbortSignal) => {
      expect(signal).not.toBe(viewer.signal);
      expect(signal.aborted).toBe(false);
    });
    queue.schedule("cancelled-viewer", work);
    viewer.abort(); await queue.run();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it("does not hold a short-lived response open for another response's existing job", async () => {
    const owner = createPortfolioHistoryBackground(Date.now() + 60_000);
    const follower = createPortfolioHistoryBackground(Date.now() + 100);
    const gate = deferred();
    owner.schedule("other-response-lifetime", async () => gate.promise);
    follower.schedule("other-response-lifetime", async () => { throw new Error("duplicate"); });
    const running = owner.run(); await flush();
    let finished = false;
    const following = follower.run().then(() => { finished = true; });
    await flush(); expect(finished).toBe(true);
    gate.resolve(); await Promise.all([running, following]);
  });

  it("cleans a failed flight so a later response can resume its durable checkpoint", async () => {
    const work = vi.fn(async () => { throw new Error("provider unavailable"); });
    const failed = createPortfolioHistoryBackground(Date.now() + 60_000);
    failed.schedule("retry-failed", work); await failed.run();
    const retry = createPortfolioHistoryBackground(Date.now() + 60_000);
    retry.schedule("retry-failed", work); await retry.run();
    expect(work).toHaveBeenCalledTimes(2);
  });

  it("does not start jobs when the response consumed the background lifetime", async () => {
    const queue = createPortfolioHistoryBackground(Date.now() - 1);
    const work = vi.fn(async () => undefined);
    queue.schedule("expired-response", work); await queue.run();
    expect(work).not.toHaveBeenCalled();
  });

  it("aborts active jobs at the overall deadline and does not dispatch queued jobs afterwards", async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
    const queue = createPortfolioHistoryBackground(1100);
    const started: number[] = [], signals: AbortSignal[] = [];
    for (let index = 0; index < 3; index++) queue.schedule(`deadline-${index}`, async (signal) => {
      started.push(index); signals.push(signal);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    });
    const run = queue.run(); await flush();
    expect(started).toEqual([0, 1]);
    await vi.advanceTimersByTimeAsync(100); await run;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(started).toEqual([0, 1]);
  });

  it("caps same-instance active flights across many response callbacks and admits later work after cleanup", async () => {
    const gate = deferred();
    const work = vi.fn(async () => gate.promise);
    const runs: Promise<void>[] = [];
    for (let index = 0; index < 33; index++) {
      const queue = createPortfolioHistoryBackground(Date.now() + 60_000);
      queue.schedule(`capacity-${index}-a`, work); queue.schedule(`capacity-${index}-b`, work);
      runs.push(queue.run());
    }
    await flush(); expect(work).toHaveBeenCalledTimes(64);
    gate.resolve(); await Promise.all(runs);
    const later = createPortfolioHistoryBackground(Date.now() + 60_000);
    later.schedule("capacity-after-cleanup", work); await later.run();
    expect(work).toHaveBeenCalledTimes(65);
  });

  it("caps each response's collected workload while replacing duplicate context entries", async () => {
    const queue = createPortfolioHistoryBackground(Date.now() + 60_000);
    const original = vi.fn(async () => undefined), replacement = vi.fn(async () => undefined);
    for (let i = 0; i < 51; i++) queue.schedule(`request-capacity-${i}`, original);
    queue.schedule("request-capacity-0", replacement);
    await queue.run();
    expect(original).toHaveBeenCalledTimes(49);
    expect(replacement).toHaveBeenCalledTimes(1);
  });
});
