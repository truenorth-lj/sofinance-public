import { describe, expect, it, vi } from "vitest";
import { AsyncCache } from "./async-cache";

function clock(start = 0) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

describe("AsyncCache", () => {
  it("de-duplicates concurrent loads and serves cached values until the TTL ends", async () => {
    const time = clock();
    const cache = new AsyncCache<number>({ ttlMs: 1000, now: time.now });
    const load = vi.fn(async () => 7);
    const [first, second] = await Promise.all([cache.get("k", load), cache.get("k", load)]);
    expect([first, second]).toEqual([7, 7]);
    expect(load).toHaveBeenCalledTimes(1);
    time.advance(999);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    time.advance(2);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys entries separately", async () => {
    const cache = new AsyncCache<string>({ ttlMs: 1000 });
    expect(await cache.get("a", async () => "A")).toBe("A");
    expect(await cache.get("b", async () => "B")).toBe("B");
    expect(await cache.get("a", async () => "again")).toBe("A");
  });

  it("does not cache failures by default and retries immediately", async () => {
    const cache = new AsyncCache<number>({ ttlMs: 1000 });
    const load = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(1);
    await expect(cache.get("k", load)).rejects.toThrow("boom");
    await expect(cache.get("k", load)).resolves.toBe(1);
  });

  it("remembers a failure briefly when failureTtlMs is set, so an outage is not hammered", async () => {
    const time = clock();
    const cache = new AsyncCache<number>({ ttlMs: 1000, failureTtlMs: 100, now: time.now });
    const load = vi.fn().mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(2);
    await expect(cache.get("k", load)).rejects.toThrow("down");
    await expect(cache.get("k", load)).rejects.toThrow("down");
    expect(load).toHaveBeenCalledTimes(1);
    time.advance(101);
    await expect(cache.get("k", load)).resolves.toBe(2);
  });

  it("evicts the oldest entry beyond maxEntries and can be cleared", async () => {
    const cache = new AsyncCache<number>({ ttlMs: 1000, maxEntries: 2 });
    const load = vi.fn(async () => 1);
    await cache.get("a", load);
    await cache.get("b", load);
    await cache.get("c", load);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(4);
    cache.clear();
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(5);
  });

  it("lets a value choose its own TTL (a degraded result is retried sooner than a good one)", async () => {
    const time = clock();
    const cache = new AsyncCache<{ good: boolean }>({ ttlMs: 10_000, ttlFor: (value) => (value.good ? 10_000 : 100), now: time.now });
    const load = vi.fn<() => Promise<{ good: boolean }>>()
      .mockResolvedValueOnce({ good: false })
      .mockResolvedValueOnce({ good: true });
    expect(await cache.get("k", load)).toEqual({ good: false });
    time.advance(50);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(1);
    time.advance(60);
    expect(await cache.get("k", load)).toEqual({ good: true });
    time.advance(5000);
    await cache.get("k", load);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
