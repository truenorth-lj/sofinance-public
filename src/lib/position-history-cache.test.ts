import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { PositionHistoryCache, cachedSyncPositionHistory, invalidatePositionHistoryCache,
  resetPositionHistoryCache, type CachedPositionHistoryOptions } from "./position-history-cache";
import type { SyncedPositionHistory } from "./position-history-sync";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function options(mint = "1".repeat(32)): CachedPositionHistoryOptions {
  return { context: { positionMint: mint, positionAccount: "2".repeat(32), poolId: "3".repeat(32),
    mintA: "4".repeat(32), mintB: "5".repeat(32), vaultA: "6".repeat(32), vaultB: "7".repeat(32) },
    store: { request: vi.fn(async () => { throw new Error("Cache fixture must not call the store"); }) }, connection: {
      getSignaturesForAddress: vi.fn(async () => []), getParsedTransaction: vi.fn(async () => null),
    }, maxSignatures: 100 };
}
function complete(): SyncedPositionHistory {
  return { history: [{ signature: "a".repeat(64), slot: 10, blockTime: 1000,
    events: [{ kind: "increase", positionNftMint: "1".repeat(32), liquidity: "10", amountA: "20", amountB: "30" }] }],
    signatureCount: 1, truncated: false, metric: { txCount: 1, elapsedMs: 10, provider: "default",
      source: "databaseIncremental", defaultTxCount: 1, fallbackReasons: [],
      historyComplete: true, fetchedTxCount: 1, listingCount: 1 } };
}
afterEach(() => { resetPositionHistoryCache(); vi.useRealTimers(); });

describe("position history short cache", () => {
  it("reports zero current stage and physical RPC work on memory hits", async () => {
    const cache = new PositionHistoryCache(), input = options();
    const load = vi.fn(async () => ({ ...complete(), metric: { ...complete().metric,
      stages: { claimMs: 3, listingMs: 4, detailsMs: 20, parseMs: 1, commitMs: 5, releaseMs: 2 },
      rpc: { attemptCount: 4, rateLimitCount: 1, queuedMs: 12, requestMs: 20, maxActive: 3,
        defaultAttempts: 2, responseBytes: 1000 }, unattributedTxCount: 1 } }));
    const first = await cache.get(input, load);
    expect(first.metric.stages?.releaseMs).toBe(2);
    expect(first.metric.rpc?.attemptCount).toBe(4);
    const hit = await cache.get(input, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hit.metric.stages).toEqual({ claimMs: 0, listingMs: 0, detailsMs: 0,
      parseMs: 0, commitMs: 0, releaseMs: 0 });
    expect(hit.metric.rpc).toEqual({ attemptCount: 0, rateLimitCount: 0, queuedMs: 0,
      requestMs: 0, maxActive: 0, defaultAttempts: 0, responseBytes: 0 });
    expect(hit.metric.unattributedTxCount).toBe(0);
  });
  it("caches only history for eight seconds, reports age/zero work and clones every result", async () => {
    let now = 1000;
    const cache = new PositionHistoryCache({ clock: () => now }), input = options();
    const load = vi.fn(async () => { now += 5; return complete(); });
    const first = await cache.get(input, load);
    expect(first.metric).toMatchObject({ memoryCacheHit: false, memoryCacheAgeMs: 0, elapsedMs: 5,
      historySyncedAt: new Date(1005).toISOString() });
    first.history[0]!.events.length = 0;
    now = 2005;
    const hit = await cache.get(input, load);
    expect(load).toHaveBeenCalledTimes(1);
    expect(hit.history[0]!.events).toHaveLength(1);
    expect(hit.metric).toMatchObject({ memoryCacheHit: true, memoryCacheAgeMs: 1000,
      fetchedTxCount: 0, listingCount: 0, defaultTxCount: 0, elapsedMs: 0 });
    hit.history.length = 0;
    expect((await cache.get(input, load)).history).toHaveLength(1);
    now = 9005;
    expect((await cache.get(input, load)).metric.memoryCacheHit).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("keys the complete context, parser version, budget, fingerprint and store identity", async () => {
    const cache = new PositionHistoryCache(), input = options(), load = vi.fn(async () => complete());
    await cache.get(input, load);
    for (const field of Object.keys(input.context) as (keyof typeof input.context)[])
      await cache.get({ ...input, context: { ...input.context, [field]: "A".repeat(32) } }, load);
    await cache.get({ ...input, parserVersion: 2 }, load);
    await cache.get({ ...input, maxSignatures: 101 }, load);
    await cache.get({ ...input, stateFingerprint: "changed" }, load);
    await cache.get({ ...input, store: { request: vi.fn(async () => { throw new Error("Cache fixture must not call the store"); }) } }, load);
    await cache.get({ ...input, maxDetailRequests: 10 }, load);
    await cache.get({ ...input, maxDetailRequests: 0 }, load);
    await cache.get({ ...input, maxDetailRequests: 1 }, load);
    expect(load).toHaveBeenCalledTimes(14);
    await cache.get({ ...input, context: { ...input.context } }, load);
    expect(load).toHaveBeenCalledTimes(14);
  });

  it("does not cache partial histories, unknown completeness or loader failures", async () => {
    const cache = new PositionHistoryCache(), input = options();
    const partial = vi.fn(async () => ({ ...complete(), truncated: true }));
    await cache.get(input, partial); await cache.get(input, partial);
    expect(partial).toHaveBeenCalledTimes(2);
    const unknown = vi.fn(async () => ({ ...complete(), metric: { ...complete().metric, historyComplete: undefined } }));
    await cache.get(input, unknown); await cache.get(input, unknown);
    expect(unknown).toHaveBeenCalledTimes(2);
    const failure = vi.fn(async () => { throw new Error("upstream unavailable"); });
    await expect(cache.get(input, failure)).rejects.toThrow("upstream unavailable");
    await expect(cache.get(input, failure)).rejects.toThrow("upstream unavailable");
    expect(failure).toHaveBeenCalledTimes(2);
  });

  it("coalesces a shared load and isolates one waiter's abort from other readers", async () => {
    const cache = new PositionHistoryCache(), input = options(), pending = deferred<SyncedPositionHistory>();
    const a = new AbortController(), b = new AbortController();
    let shared!: AbortSignal;
    const load = vi.fn(async (request) => { shared = request.signal!; return pending.promise; });
    const first = cache.get({ ...input, signal: a.signal }, load), second = cache.get({ ...input, signal: b.signal }, load);
    const rejected = expect(first).rejects.toThrow("viewer one left");
    await Promise.resolve();
    expect(shared).not.toBe(a.signal); expect(shared).not.toBe(b.signal);
    a.abort(new Error("viewer one left"));
    await rejected;
    expect(shared.aborted).toBe(false);
    pending.resolve(complete());
    expect((await second).truncated).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    expect((await cache.get(input, load)).metric.memoryCacheHit).toBe(true);
  });

  it("aborts shared work when every waiter leaves, removes it and permits an immediate retry", async () => {
    const cache = new PositionHistoryCache(), input = options(), pending = deferred<SyncedPositionHistory>();
    const a = new AbortController(), b = new AbortController();
    let shared!: AbortSignal;
    const load = vi.fn(async request => { shared = request.signal!; return pending.promise; });
    const first = cache.get({ ...input, signal: a.signal }, load), second = cache.get({ ...input, signal: b.signal }, load);
    const rejectedA = expect(first).rejects.toThrow("one"), rejectedB = expect(second).rejects.toThrow("two");
    await Promise.resolve();
    a.abort(new Error("one")); expect(shared.aborted).toBe(false);
    b.abort(new Error("two")); expect(shared.aborted).toBe(true);
    await Promise.all([rejectedA, rejectedB]);
    const fresh = vi.fn(async () => complete());
    await cache.get(input, fresh);
    pending.resolve({ ...complete(), signatureCount: 99 });
    await Promise.resolve();
    expect((await cache.get(input, fresh)).signatureCount).toBe(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("fences stale inflight results after invalidation and keeps unrelated positions cached", async () => {
    const cache = new PositionHistoryCache(), input = options(), other = options("B".repeat(32));
    const ready = vi.fn(async () => complete()), pending = deferred<SyncedPositionHistory>();
    await cache.get(other, ready);
    const stale = cache.get(input, async () => pending.promise);
    const rejected = expect(stale).rejects.toMatchObject({ code: "POSITION_HISTORY_CACHE_INVALIDATED" });
    cache.invalidate(input.context.positionMint);
    await rejected;
    pending.resolve({ ...complete(), signatureCount: 99 });
    await Promise.resolve();
    expect((await cache.get(input, ready)).signatureCount).toBe(1);
    expect((await cache.get(other, ready)).metric.memoryCacheHit).toBe(true);
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("bypass invalidates all matching entries and does not join old work", async () => {
    const cache = new PositionHistoryCache(), input = options(), pending = deferred<SyncedPositionHistory>();
    const old = cache.get(input, async () => pending.promise);
    const rejected = expect(old).rejects.toMatchObject({ code: "POSITION_HISTORY_CACHE_INVALIDATED" });
    const fresh = vi.fn(async () => complete());
    expect((await cache.get({ ...input, bypassCache: true }, fresh)).metric.memoryCacheHit).toBe(false);
    await rejected;
    pending.resolve({ ...complete(), signatureCount: 99 });
    await Promise.resolve();
    expect((await cache.get(input, fresh)).signatureCount).toBe(1);
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("enforces the independent shared loader's fifty-second deadline without caching its failure", async () => {
    vi.useFakeTimers();
    const cache = new PositionHistoryCache(), input = options();
    let shared!: AbortSignal;
    const timed = cache.get(input, async request => { shared = request.signal!; return new Promise(() => {}); });
    const rejected = expect(timed).rejects.toMatchObject({ name: "TimeoutError" });
    await vi.advanceTimersByTimeAsync(50_000);
    await rejected;
    expect(shared.aborted).toBe(true);
    expect((await cache.get(input, async () => complete())).metric.memoryCacheHit).toBe(false);
  });

  it("limits entries to sixty-four and evicts by total serialized bytes", async () => {
    const cache = new PositionHistoryCache({ clock: () => 0 }), load = vi.fn(async () => complete());
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const inputs = Array.from({ length: 65 }, (_, i) => options((alphabet[Math.floor(i / 58)]! + alphabet[i % 58]!).padStart(32, "1")));
    for (const input of inputs) await cache.get(input, load);
    expect((await cache.get(inputs.at(-1)!, load)).metric.memoryCacheHit).toBe(true);
    expect((await cache.get(inputs[0]!, load)).metric.memoryCacheHit).toBe(false);
    expect(load).toHaveBeenCalledTimes(66);
    cache.reset();
    const large = vi.fn(async () => { const value = complete(); value.history[0]!.signature = "x".repeat(3 * 1024 * 1024); return value; });
    for (const input of inputs.slice(0, 3)) await cache.get(input, large);
    expect((await cache.get(inputs[2]!, large)).metric.memoryCacheHit).toBe(true);
    expect((await cache.get(inputs[0]!, large)).metric.memoryCacheHit).toBe(false);
    expect(large).toHaveBeenCalledTimes(4);
  });

  it("exposes singleton invalidation/reset and rejects pre-aborted readers without starting work", async () => {
    const input = options(), load = vi.fn(async () => complete());
    await cachedSyncPositionHistory(input, load);
    expect((await cachedSyncPositionHistory(input, load)).metric.memoryCacheHit).toBe(true);
    invalidatePositionHistoryCache(input.context.positionMint);
    await cachedSyncPositionHistory(input, load);
    resetPositionHistoryCache();
    await cachedSyncPositionHistory(input, load);
    expect(load).toHaveBeenCalledTimes(3);
    const signal = AbortSignal.abort(new Error("already left"));
    await expect(cachedSyncPositionHistory({ ...input, signal }, load)).rejects.toThrow("already left");
    expect(load).toHaveBeenCalledTimes(3);
  });
});
