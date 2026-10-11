import { describe, expect, it } from "vitest";
import { createConcurrencyLimit } from "./concurrency-limit";

describe("createConcurrencyLimit", () => {
  it("never runs more than `limit` tasks at once and keeps FIFO order", async () => {
    const run = createConcurrencyLimit(2);
    let active = 0;
    let peak = 0;
    const started: number[] = [];
    const task = (id: number) => run(async () => {
      started.push(id);
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return id;
    });
    const results = await Promise.all([1, 2, 3, 4, 5].map(task));
    expect(results).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
    expect(started).toEqual([1, 2, 3, 4, 5]);
  });

  it("keeps draining after a task fails", async () => {
    const run = createConcurrencyLimit(1);
    const failing = run(async () => { throw new Error("nope"); });
    const after = run(async () => "ok");
    await expect(failing).rejects.toThrow("nope");
    await expect(after).resolves.toBe("ok");
  });

  it("rejects an invalid limit", () => {
    expect(() => createConcurrencyLimit(0)).toThrow();
    expect(() => createConcurrencyLimit(1.5)).toThrow();
  });
});
