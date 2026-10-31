import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const loadProfile = vi.hoisted(() => vi.fn());
vi.mock("./pool-range-apr", async (load) => {
  const actual = await load<typeof import("./pool-range-apr")>();
  const { payloadFixture } = await import("./range-apr/payload.fixture");
  return {
    ...actual, loadVolumeProfile: loadProfile,
    // The APR maths is tested elsewhere; here only degraded / stale matter.
    assemblePoolRangeApr: (poolId: string, profile: VolumeProfile) => {
      const payload = payloadFixture({ poolId });
      const degraded = !actual.hasPriceHistory(profile);
      payload.sample = { ...payload.sample, degraded, ...(profile.stale && !degraded ? { priceHistoryStale: true } : {}) };
      return payload;
    },
  };
});
vi.mock("./range-apr/onchain-liquidity", () => ({ readOnchainPoolLiquidity: async () => ({ mintA: "a", mintB: "b" }) }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));
const rhcFlag = vi.hoisted(() => ({ enabled: false }));
vi.mock("./protocol-flags", async (load) => ({ ...await load<typeof import("./protocol-flags")>(), isRhcApr7dEnabled: () => rhcFlag.enabled }));
const rhcRun = vi.hoisted(() => ({ prepare: vi.fn() }));
vi.mock("./rhc-apr-refresh", async (load) => ({ ...await load<object>(), prepareRhcRun: rhcRun.prepare }));
import { activePoolRefreshedAt, APR_POOL_MAX_MS, APR_POOLS_PER_RUN, APR_QUEUE_FIXED_MS, APR_SAVE_RESERVE_MS, orderAprQueue, refreshProfile, runJob } from "./rwa-refresh";
import { createCronGeckoGate, CRON_GECKO_SPACING_MS } from "./pool-metrics/gecko";
import { ThrottleGate } from "./range-apr/throttle-gate";
import type { RwaStore } from "./rwa-store-types";
import { ALGORITHM_VERSION, type ActivePool } from "./rwa-store-types";
import type { VolumeProfile } from "./pool-range-apr";

const now = Date.parse("2026-10-14T00:15:00Z");
function fixture(): ActivePool {
  const profile = { economics: { mintA: "a", mintB: "b" }, candles: [{ timestamp: 1 }], stale: false,
    daily: null, issues: [], observedAt: { economics: "2026-10-14T00:12:00Z", daily: null, hourly: "2026-10-14T00:11:00Z" } } as unknown as VolumeProfile;
  return { pair: { poolAddress: "pool", mintA: "a", mintB: "b" } as ActivePool["pair"], metricsObservedAt: "2026-10-14T00:12:00Z",
    profile: { algorithmVersion: ALGORITHM_VERSION, profile, observedAt: "2026-10-14T00:11:00Z", windowEndUtc: "2026-10-14T00:00:00.000Z" },
    refreshedAt: null };
}
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); rhcFlag.enabled = false; });
describe("persistent market profile", () => {
  it("reuses a current cached profile without retimestamping or upstream requests", async () => {
    const pool = fixture();
    expect(await refreshProfile(pool, fetch, now, new AbortController().signal)).toBe(pool.profile);
    expect(loadProfile).not.toHaveBeenCalled();
  });
  it("invalidates the cache after a UTC rollover or algorithm change", async () => {
    const pool = fixture();
    pool.profile!.windowEndUtc = "2026-10-13T00:00:00.000Z";
    loadProfile.mockResolvedValue(pool.profile!.profile);
    const result = await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(loadProfile).toHaveBeenCalledTimes(1);
    expect(result.windowEndUtc).toBe("2026-10-14T00:00:00.000Z");
    expect(result.observedAt).toBe("2026-10-14T00:11:00Z");
    pool.profile!.algorithmVersion = "old";
    await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(loadProfile).toHaveBeenCalledTimes(2);
  });
  it("preserves the age and marks fallback candles stale after upstream failure", async () => {
    const pool = fixture();
    pool.profile!.observedAt = "2026-10-13T23:00:00Z";
    loadProfile.mockResolvedValue({ ...pool.profile!.profile, candles: null });
    const result = await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(result.observedAt).toBe("2026-10-13T23:00:00Z");
    expect(result.profile.stale).toBe(true);
    expect(result.profile.candles).toEqual(pool.profile!.profile.candles);
  });
  it("falls back to saved price history up to 48h old (stale, not degraded), not beyond", async () => {
    const pool = fixture();
    loadProfile.mockResolvedValue({ ...pool.profile!.profile, candles: null });
    pool.profile!.observedAt = new Date(now - 47 * 3_600_000).toISOString();
    expect((await refreshProfile(pool, fetch, now, new AbortController().signal)).profile.stale).toBe(true);
    pool.profile!.observedAt = new Date(now - 49 * 3_600_000).toISOString();
    const expired = await refreshProfile(pool, fetch, now, new AbortController().signal);
    expect(expired.profile.candles).toBeNull();
    expect(expired.profile.stale).toBeFalsy();
  });
  it("hands the run's cron gate to the price-history fetch", async () => {
    const pool = fixture();
    pool.profile!.windowEndUtc = "2026-10-13T00:00:00.000Z";
    loadProfile.mockResolvedValue(pool.profile!.profile);
    const gate = new ThrottleGate();
    await refreshProfile(pool, fetch, now, new AbortController().signal, { gate });
    expect(loadProfile.mock.calls[0]![3]).toMatchObject({ gate });
  });
});

const goodProfile = fixture().profile!.profile;
const throttledProfile = { ...goodProfile, candles: null, issues: ["GeckoTerminal hourly candles: throttled (429); cooling down 20s"] };
const hours = (h: number) => new Date(now - h * 3_600_000).toISOString();
/** Solana pools due for a fetch (yesterday's window), each with when it was last refreshed. */
function solanaPools(rows: Array<[string, string | null]>): ActivePool[] {
  return rows.map(([poolAddress, refreshedAt]) => {
    const pool = fixture();
    pool.pair = { ...pool.pair, poolAddress };
    pool.profile!.windowEndUtc = "2026-10-13T00:00:00.000Z";
    pool.profile!.observedAt = "2026-10-13T00:11:00Z";
    return { ...pool, refreshedAt };
  });
}
function memoryStore(active: ActivePool[]) {
  const saved: Array<{ poolId: string; payload: { sample: { degraded: boolean; priceHistoryStale?: boolean } } | null }> = [];
  const ops: string[] = [];
  const store = {
    request: async (input: { op: string; data?: unknown }) => {
      ops.push(input.op);
      switch (input.op) {
        case "claim": return { job: "rwa-apr-refresh", token: "t" };
        case "activePools": return active;
        case "saveApr": saved.push(input.data as (typeof saved)[number]); return null;
        default: return null;
      }
    },
  } as unknown as RwaStore;
  return { store, saved, ops };
}
const openGate = () => new ThrottleGate({ minSpacingMs: 0 });
const run = (store: RwaStore, extra: { deadlineMs?: number; geckoGate?: ThrottleGate } = {}) =>
  runJob("rwa-apr-refresh", { store, clock: () => now, deadlineMs: now + 200_000, geckoGate: openGate(), ...extra });

describe("APR queue: one oldest-first queue, one pool at a time", () => {
  it("orders never-refreshed pools first, then the oldest refresh or attempt, then pool id", () => {
    const order = orderAprQueue([
      { poolId: "c", refreshedAt: hours(1) }, { poolId: "b", refreshedAt: hours(9) }, { poolId: "z", refreshedAt: null },
      { poolId: "a", refreshedAt: hours(9) }, { poolId: "y", refreshedAt: "garbage" },
    ]).map((row) => row.poolId);
    expect(order).toEqual(["y", "z", "a", "b", "c"]);
  });

  it("refreshes only the APR_POOLS_PER_RUN oldest pools, oldest first, never two at once", async () => {
    const rows: Array<[string, string | null]> = Array.from({ length: APR_POOLS_PER_RUN + 3 }, (_, i) => [`pool${String(i).padStart(2, "0")}`, hours(i)]);
    const { store, saved } = memoryStore(solanaPools(rows));
    let inFlight = 0, maxInFlight = 0;
    loadProfile.mockImplementation(async () => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return goodProfile;
    });
    const result = await run(store);
    expect(result).toMatchObject({ status: "ok", processed: APR_POOLS_PER_RUN, queue: { pools: rows.length, selected: APR_POOLS_PER_RUN, done: APR_POOLS_PER_RUN, stoppedBy: null } });
    // Oldest (largest age) first; the 3 most recently refreshed wait for the next run.
    const expected = rows.map(([id]) => id).reverse().slice(0, APR_POOLS_PER_RUN);
    expect(loadProfile.mock.calls.map((call) => call[0])).toEqual(expected);
    expect(saved.map((row) => row.poolId)).toEqual(expected);
    expect(maxInFlight).toBe(1);
  });

  it("puts Solana and RHC pools in one queue and runs them one after another on the same gate", async () => {
    rhcFlag.enabled = true;
    const events: string[] = [];
    let inFlight = 0, maxInFlight = 0;
    const refreshPool = vi.fn(async (spec: { poolId: string }) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      events.push(spec.poolId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return "saved";
    });
    rhcRun.prepare.mockResolvedValue({
      pools: [["0xr1", hours(5)], ["0xr2", null], ["0xr3", hours(1)]].map(([poolId, refreshedAt]) => ({ spec: { poolId }, poolId, refreshedAt })),
      refreshPool, issues: [], stats: { fetched: 0, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0 },
    });
    const { store } = memoryStore(solanaPools([["solA", hours(3)], ["solB", hours(7)]]));
    loadProfile.mockImplementation(async (poolId: string) => {
      maxInFlight = Math.max(maxInFlight, ++inFlight);
      events.push(poolId);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return goodProfile;
    });
    const gate = openGate();
    const result = await run(store, { geckoGate: gate });
    expect(events).toEqual(["0xr2", "solB", "0xr1", "solA", "0xr3"]);
    expect(maxInFlight).toBe(1);
    expect(rhcRun.prepare.mock.calls[0]![0].gate).toBe(gate);
    expect(loadProfile.mock.calls.every((call) => call[3].gate === gate)).toBe(true);
    expect(result).toMatchObject({ processed: 5, queue: { pools: 5, done: 5 }, rhc: { deferred: 0 } });
  });

  it("ends the run on a 429: the throttled pool is not saved and later pools are not started", async () => {
    const { store, saved } = memoryStore(solanaPools([["poolA", hours(9)], ["poolB", hours(8)], ["poolC", hours(7)]]));
    const gate = openGate();
    loadProfile.mockImplementation(async (poolId: string) => {
      if (poolId !== "poolB") return goodProfile;
      gate.block(20_000);
      return throttledProfile;
    });
    const result = await run(store, { geckoGate: gate });
    expect(loadProfile.mock.calls.map((call) => call[0])).toEqual(["poolA", "poolB"]);
    expect(saved.map((row) => row.poolId)).toEqual(["poolA"]);
    expect(result).toMatchObject({ status: "partial", processed: 1, queue: { selected: 3, done: 1, stoppedBy: "429" } });
    expect(result.issues).toEqual(["GeckoTerminal 429: run ended after 1 of 3 pools; the rest go first next run"]);
  });

  it("ends the run before any pool when the RHC pools/multi call hit a 429", async () => {
    rhcFlag.enabled = true;
    const gate = openGate();
    const refreshPool = vi.fn();
    rhcRun.prepare.mockImplementation(async () => {
      gate.block(20_000);
      return { pools: [{ spec: { poolId: "0xr1" }, poolId: "0xr1", refreshedAt: null }], refreshPool,
        issues: ["RHC market: GeckoTerminal pools/multi: HTTP 429"], stats: { fetched: 0, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0 } };
    });
    const { store, saved } = memoryStore(solanaPools([["poolA", hours(9)]]));
    const result = await run(store, { geckoGate: gate });
    expect(refreshPool).not.toHaveBeenCalled();
    expect(loadProfile).not.toHaveBeenCalled();
    expect(saved).toHaveLength(0);
    expect(result).toMatchObject({ queue: { done: 0, stoppedBy: "429" }, rhc: { deferred: 1 } });
  });

  it("keeps the progress made before a 429: pools saved earlier in the run stay saved (11/1 00:15: 3 saved, 4th 429)", async () => {
    const { store, saved, ops } = memoryStore(solanaPools([["poolA", hours(9)], ["poolB", hours(8)], ["poolC", hours(7)], ["poolD", hours(6)], ["poolE", hours(5)]]));
    const gate = openGate();
    loadProfile.mockImplementation(async (poolId: string) => {
      if (poolId !== "poolD") return goodProfile;
      gate.block(20_000);
      return throttledProfile;
    });
    const result = await run(store, { geckoGate: gate });
    // Each pool is its own saveApr request, sent before the next pool starts: the 429 cannot undo them.
    expect(saved.map((row) => row.poolId)).toEqual(["poolA", "poolB", "poolC"]);
    expect(ops.filter((op) => op === "saveApr")).toHaveLength(3);
    expect(ops.lastIndexOf("saveApr")).toBeLessThan(ops.length - 1);
    expect(result).toMatchObject({ status: "partial", processed: 3, queue: { done: 3, stoppedBy: "429" } });
    expect(result.issues).toContain("GeckoTerminal 429: run ended after 3 of 5 pools; the rest go first next run");
  });

  it("a non-429 failure still saves from saved price history (≤ 48h, stale) and the run goes on", async () => {
    const { store, saved } = memoryStore(solanaPools([["poolA", hours(9)], ["poolB", hours(8)]]));
    loadProfile.mockImplementation(async (poolId: string) => (poolId === "poolA" ? { ...goodProfile, candles: null, issues: ["GeckoTerminal hourly candles: HTTP 500"] } : goodProfile));
    const result = await run(store);
    expect(saved.map((row) => row.poolId)).toEqual(["poolA", "poolB"]);
    expect(saved[0]!.payload?.sample).toMatchObject({ degraded: false, priceHistoryStale: true });
    expect(result).toMatchObject({ status: "partial", processed: 2, issues: ["poolA: Using previously saved price history"] });
  });

  it("starts no pool without the slowest single-pool time (~32 s at 12 s spacing) plus the save reserve left", async () => {
    expect(APR_POOL_MAX_MS).toBeGreaterThanOrEqual(2 * CRON_GECKO_SPACING_MS + 5_000);
    const { store } = memoryStore(solanaPools([["poolA", hours(9)]]));
    loadProfile.mockResolvedValue(goodProfile);
    const result = await run(store, { deadlineMs: now + APR_POOL_MAX_MS + APR_SAVE_RESERVE_MS - 1 });
    expect(loadProfile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ queue: { done: 0, stoppedBy: "time" } });
    const enough = memoryStore(solanaPools([["poolA", hours(9)]]));
    expect(await run(enough.store, { deadlineMs: now + APR_POOL_MAX_MS + APR_SAVE_RESERVE_MS + 1 })).toMatchObject({ queue: { done: 1, stoppedBy: null } });
  });

  it("a job timeout that fires mid-pool stops the run cleanly with reason 'time' (that pool saves nothing)", async () => {
    const { store, saved } = memoryStore(solanaPools([["poolA", hours(9)], ["poolB", hours(8)]]));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The job's AbortSignal.timeout is clamped to 1 s by this deadline; poolA's fetch outlives it.
      loadProfile.mockImplementation((_id: string, _f: unknown, _n: number, options: { retry: { signal: AbortSignal } }) =>
        new Promise((_, reject) => options.retry.signal.addEventListener("abort", () => reject(options.retry.signal.reason))));
      const pending = runJob("rwa-apr-refresh", { store, clock: () => now, deadlineMs: now + 1_000, geckoGate: openGate() });
      await vi.advanceTimersByTimeAsync(1_100);
      const result = await pending;
      expect(result).toMatchObject({ status: "partial", queue: { done: 0, stoppedBy: "time" } });
      expect(saved).toHaveLength(0);
      expect(result.issues.at(-1)).toBe("Time budget: run ended after 0 of 2 pools; the rest go first next run");
    } finally { vi.useRealTimers(); }
  });

  it("a 429 is sticky: the run ends even when the gate's cooldown has already passed by the check", async () => {
    let clock = now;
    const gate = createCronGeckoGate({ now: () => clock, sleep: async () => undefined });
    const { store, saved } = memoryStore(solanaPools([["poolA", hours(9)], ["poolB", hours(8)], ["poolC", hours(7)]]));
    loadProfile.mockImplementation(async (poolId: string) => {
      if (poolId !== "poolA") return goodProfile;
      gate.block(5_000);
      clock += 60_000; // the RPC read (≤ 8 s) and more: the 5 s cooldown is long over
      return throttledProfile;
    });
    const result = await run(store, { geckoGate: gate });
    expect(gate.blockedForMs()).toBeGreaterThan(0);
    expect(loadProfile.mock.calls.map((call) => call[0])).toEqual(["poolA"]);
    expect(saved).toHaveLength(0);
    expect(result).toMatchObject({ queue: { done: 0, stoppedBy: "429" } });
  });

  it("queue key falls back to the saved profile's last attempt / observation when the store sends none", () => {
    const pool = fixture();
    expect(activePoolRefreshedAt({ ...pool, refreshedAt: "2026-10-14T01:00:00Z" })).toBe("2026-10-14T01:00:00Z");
    expect(activePoolRefreshedAt(pool)).toBe("2026-10-14T00:11:00Z");
    pool.profile!.fetchState = { lastAttemptAt: "2026-10-14T00:30:00Z", failures: 1 };
    expect(activePoolRefreshedAt(pool)).toBe("2026-10-14T00:30:00Z");
    expect(activePoolRefreshedAt({ ...pool, profile: null })).toBeNull();
  });

  it("seeds RHC history rows only when the RHC 7d APR flag is on", async () => {
    const calls: unknown[] = [];
    const { store } = memoryStore([]);
    const request = store.request.bind(store);
    (store as { request: unknown }).request = async (input: { op: string }) => { if (input.op === "prepareDaily") calls.push(input); return request(input as never); };
    await run(store);
    expect(calls[0]).toMatchObject({ includeRhc: false });
  });

  it("refreshes every pool within 24h at 6 runs/day at 12 s spacing, also when one run ends at once on a 429", () => {
    // 10/31: 18 Solana (2 GeckoTerminal calls) + 11 RHC (1 call) active pools. A run fits ~12 candle calls at 12 s
    // spacing in the APR job (180 s − 15 s fixed − the start guard); model that budget with the real queue order.
    const callsPerRun = Math.floor((180_000 - APR_QUEUE_FIXED_MS - APR_SAVE_RESERVE_MS) / CRON_GECKO_SPACING_MS);
    expect(callsPerRun).toBe(12);
    const pools = Array.from({ length: 29 }, (_, i) => ({ poolId: `p${i}`, calls: i < 18 ? 2 : 1, refreshedAt: null as string | null }));
    const runPools = (at: number) => {
      let budget = callsPerRun;
      for (const pool of orderAprQueue(pools).slice(0, APR_POOLS_PER_RUN)) {
        if (pool.calls > budget) break;
        budget -= pool.calls;
        pool.refreshedAt = new Date(at).toISOString();
        if (last.has(pool.poolId)) worstGapMs = Math.max(worstGapMs, at - last.get(pool.poolId)!);
        last.set(pool.poolId, at);
      }
    };
    const last = new Map<string, number>();
    let worstGapMs = 0;
    const start = Date.parse("2026-11-01T00:15:00Z");
    for (let runIndex = 0; runIndex < 24; runIndex++) {
      const at = start + runIndex * 4 * 3_600_000;
      if (runIndex !== 10) runPools(at); // one run refreshes nothing (429 at once)
      if (runIndex >= 6) for (const pool of pools) expect(at - last.get(pool.poolId)!).toBeLessThan(24 * 3_600_000);
    }
    expect(last.size).toBe(29);
    expect(worstGapMs).toBeLessThanOrEqual(20 * 3_600_000);
    // The cap never binds before the time budget does: 12 one-call RHC pools are the most a run can fit.
    expect(APR_POOLS_PER_RUN).toBeGreaterThanOrEqual(callsPerRun);
  });
});
