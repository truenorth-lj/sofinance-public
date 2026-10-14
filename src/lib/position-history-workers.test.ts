import { describe, expect, it, vi } from "vitest";
import { mapPositionHistoryWorkers } from "./position-history-workers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("fixed eight position history workers", () => {
  it("starts the ninth job while the first slow job remains active, caps active jobs and retains original order", async () => {
    const jobs = Array.from({ length: 12 }, () => deferred<number>());
    const started: number[] = [];
    let active = 0, peak = 0;
    const pending = mapPositionHistoryWorkers(jobs, async (job, index) => {
      started.push(index); active++; peak = Math.max(peak, active);
      try { return await job.promise; } finally { active--; }
    });
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    jobs[3]!.resolve(30);
    await flush();
    expect(started).toContain(8);
    expect(active).toBe(8);
    expect(peak).toBe(8);
    for (const [index, job] of jobs.entries()) if (index !== 3) job.resolve(index * 10);
    expect(await pending).toEqual(Array.from({ length: 12 }, (_, index) => index * 10));
    expect(peak).toBe(8); expect(active).toBe(0);
  });

  it("stops dispatch on abort and drains active jobs before rejecting", async () => {
    const controller = new AbortController();
    const jobs = Array.from({ length: 12 }, () => deferred<number>());
    const callback = vi.fn(async (job: typeof jobs[number]) => job.promise);
    let settled = false;
    const pending = mapPositionHistoryWorkers(jobs, callback, { signal: controller.signal });
    const rejected = pending.catch(error => { settled = true; return error; });
    const error = new Error("viewer left");
    controller.abort(error);
    jobs[0]!.resolve(0);
    await flush();
    expect(callback).toHaveBeenCalledTimes(8);
    expect(settled).toBe(false);
    for (const job of jobs.slice(1, 8)) job.resolve(1);
    expect(await rejected).toBe(error);
    expect(callback).toHaveBeenCalledTimes(8);
  });

  it("stops on a fatal callback failure and observes all active rejections", async () => {
    const jobs = Array.from({ length: 12 }, () => deferred<number>());
    const callback = vi.fn(async (job: typeof jobs[number]) => job.promise);
    let settled = false;
    const pending = mapPositionHistoryWorkers(jobs, callback);
    const rejected = pending.catch(error => { settled = true; return error; });
    const firstError = new Error("fatal receipt handling");
    jobs[2]!.reject(firstError);
    await flush();
    expect(settled).toBe(false);
    for (const [index, job] of jobs.slice(0, 8).entries()) {
      if (index === 2) continue;
      job.reject(new Error(`drained job ${index}`));
    }
    expect(await rejected).toBe(firstError);
    expect(callback).toHaveBeenCalledTimes(8);
  });

  it("does not dispatch pre-aborted or empty work", async () => {
    const callback = vi.fn(async (value: number) => value);
    await expect(mapPositionHistoryWorkers([1], callback, { signal: AbortSignal.abort(new Error("already left")) }))
      .rejects.toThrow("already left");
    expect(await mapPositionHistoryWorkers([], callback)).toEqual([]);
    expect(callback).not.toHaveBeenCalled();
  });
});
