import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { describe, expect, it, vi } from "vitest";
import dexScreenerCapture from "../../packages/engine/src/fixtures/univ4-rhc-spcx-dexscreener.json";
import geckoCapture from "../../packages/engine/src/fixtures/univ4-rhc-spcx-geckoterminal.json";

vi.mock("server-only", () => ({}));
const discovery = vi.hoisted(() => ({ summaries: [] as unknown[] }));
vi.mock("@sofinance/engine/protocols/uniswap-v4/discovery", async (load) => ({
  ...(await load<object>()),
  discoverUniv4RhcPools: vi.fn(async () => discovery.summaries),
}));
const rangeApr = vi.hoisted(() => ({ liquidity: 0 }));
vi.mock("./rhc-range-apr", async (load) => ({
  ...(await load<object>()),
  rhcLiquidityAt: vi.fn(async () => { rangeApr.liquidity += 1; return {}; }),
  assembleRhcRangeApr: vi.fn(() => ({ sample: { days: 7, issues: [], degraded: false } })),
}));
import { ThrottleGate } from "./range-apr/throttle-gate";
import {
  fetchRhcMarketBatch, planRhcProfileFetches, withTimeout, prepareRhcRun, rhcFailureBackoffMs, rhcPoolCreatedAtSeconds,
  rhcProfilePriority, rollRhcProfileForward, RHC_PROFILE_MAX_AGE_MS,
} from "./rhc-apr-refresh";
import type { Univ4MarketData } from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { volumeWindowEnd } from "./rwa-daily";
import { ALGORITHM_VERSION, type Lease, type RwaStore, type StoredProfile } from "./rwa-store-types";

const POOLS = UNIV4_RHC_ALLOWLISTED_POOLS;
const SPCX = POOLS[0]!;
const NOW = Date.parse("2026-10-30T08:00:00Z");
const gate = () => new ThrottleGate({ minSpacingMs: 0, sleep: async () => undefined });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

type ProfileOver = {
  observedAt?: number; windowEndUtc?: string; candles?: unknown[] | null; stale?: boolean; hourlyAt?: number;
  fetchState?: StoredProfile["fetchState"];
};
function profile(spec: (typeof POOLS)[number], over: ProfileOver = {}): StoredProfile {
  return {
    ...(over.fetchState ? { fetchState: over.fetchState } : {}),
    algorithmVersion: ALGORITHM_VERSION,
    windowEndUtc: over.windowEndUtc ?? volumeWindowEnd(NOW),
    observedAt: new Date(over.observedAt ?? NOW - 60_000).toISOString(),
    profile: {
      economics: { mintA: spec.currency0.address, mintB: spec.currency1.address } as never,
      daily: { avgDailyVolumeUsd: 10, days: 7 }, candles: (over.candles === undefined ? [{}] : over.candles) as never,
      sources: [], issues: [], stale: over.stale,
      ...(over.hourlyAt ? { observedAt: { economics: new Date(over.hourlyAt).toISOString(), daily: null, hourly: new Date(over.hourlyAt).toISOString() } } : {}),
    },
  };
}

describe("RHC cron profile planning (backoff, roll-forward)", () => {
  it("ranks missing < older UTC window < old/stale < current", () => {
    expect(rhcProfilePriority(null, NOW)).toBe(0);
    expect(rhcProfilePriority(profile(SPCX, { candles: null }), NOW)).toBe(0);
    expect(rhcProfilePriority(profile(SPCX, { windowEndUtc: volumeWindowEnd(NOW - 86_400_000) }), NOW)).toBe(1);
    expect(rhcProfilePriority(profile(SPCX, { observedAt: NOW - RHC_PROFILE_MAX_AGE_MS }), NOW)).toBe(2);
    expect(rhcProfilePriority(profile(SPCX, { stale: true }), NOW)).toBe(2);
    expect(rhcProfilePriority(profile(SPCX), NOW)).toBe(3);
  });

  it("fetches missing or old histories and reuses current ones", () => {
    const profiles: Record<string, StoredProfile | null> = {};
    for (const spec of POOLS) profiles[spec.poolId.toLowerCase()] = profile(spec);
    profiles[POOLS[3]!.poolId.toLowerCase()] = null;
    profiles[POOLS[5]!.poolId.toLowerCase()] = profile(POOLS[5]!, { observedAt: NOW - 7 * 3_600_000 });
    const plan = planRhcProfileFetches(POOLS, profiles, NOW);
    const fetches = POOLS.filter((spec) => plan.get(spec.poolId.toLowerCase())!.action === "fetch");
    expect(fetches).toEqual([POOLS[3]!, POOLS[5]!]);
    expect(plan.get(POOLS[0]!.poolId.toLowerCase())).toMatchObject({ action: "reuse" });
    expect(plan.get(POOLS[0]!.poolId.toLowerCase())!.cached).not.toBeNull();
    expect(plan.size).toBe(POOLS.length);
  });

  it("waits out a failed fetch's backoff (keeps the saved history meanwhile)", () => {
    const yesterday = volumeWindowEnd(NOW - 86_400_000);
    const at = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
    const [a, b, c] = POOLS;
    const profiles = {
      // failed once, 30 h ago (backoff 12 h): due again
      [a!.poolId.toLowerCase()]: profile(a!, { windowEndUtc: yesterday, observedAt: NOW - 40 * 3_600_000, fetchState: { lastAttemptAt: at(30), failures: 1 } }),
      [b!.poolId.toLowerCase()]: profile(b!, { windowEndUtc: yesterday, observedAt: NOW - 24 * 3_600_000 }),
      // failed 3 times, 20 h ago: backoff 48 h, not due
      [c!.poolId.toLowerCase()]: profile(c!, { windowEndUtc: yesterday, observedAt: NOW - 50 * 3_600_000, fetchState: { lastAttemptAt: at(20), failures: 3 } }),
    };
    const plan = planRhcProfileFetches([a!, b!, c!], profiles, NOW);
    expect([a!, b!, c!].map((spec) => plan.get(spec.poolId.toLowerCase())!.action)).toEqual(["fetch", "fetch", "reuse"]);
    expect([1, 2, 3, 4, 10].map(rhcFailureBackoffMs)).toEqual([12, 24, 48, 96, 96].map((h) => h * 3_600_000));
  });

  it("rolls a quiet pool forward without a call only when its history covers the last 24 h", () => {
    const yesterday = volumeWindowEnd(NOW - 86_400_000);
    const quiet = new Map<string, Univ4MarketData>([[SPCX.poolId.toLowerCase(),
      { source: "geckoterminal", volume24hUsd: 0, tvlUsd: 1, txns24h: 0, reserves: null, priceUsd: { token0: 10, token1: 10 } }]]);
    const plan = (over: ProfileOver, market = quiet) =>
      planRhcProfileFetches([SPCX], { [SPCX.poolId.toLowerCase()]: profile(SPCX, { windowEndUtc: yesterday, ...over }) }, NOW, market)
        .get(SPCX.poolId.toLowerCase())!.action;
    expect(plan({ hourlyAt: NOW - 24 * 3_600_000 })).toBe("roll");
    expect(plan({ hourlyAt: NOW - 26 * 3_600_000 })).toBe("fetch");
    expect(plan({ hourlyAt: NOW - 26 * 3_600_000, fetchState: { lastAttemptAt: new Date(NOW - 86_400_000).toISOString(), failures: 0, coveredUntil: new Date(NOW - 23 * 3_600_000).toISOString() } })).toBe("roll");
    expect(plan({ hourlyAt: NOW - 3_600_000, stale: true })).toBe("fetch");
    expect(plan({ hourlyAt: NOW - 3_600_000 }, new Map([[SPCX.poolId.toLowerCase(), { ...quiet.get(SPCX.poolId.toLowerCase())!, txns24h: 3, volume24hUsd: 50 }]]))).toBe("fetch");
    expect(plan({ hourlyAt: NOW - 3_600_000 }, new Map())).toBe("fetch");
  });

  it("rolls the saved candles to today's window; the missing days count as zero volume", () => {
    const H = 3_600;
    const nowS = Math.floor(NOW / 1000), today = nowS - (nowS % 86_400);
    const candles = [{ time: today - 2 * 86_400 + 5 * H, volume: 3 }, { time: today - 2 * 86_400 + 6 * H, volume: 1 }];
    const rolled = rollRhcProfileForward(profile(SPCX, { windowEndUtc: volumeWindowEnd(NOW - 86_400_000), candles }), SPCX, NOW, 10);
    expect(rolled.windowEndUtc).toBe(volumeWindowEnd(NOW));
    expect(rolled.fetchState).toMatchObject({ failures: 0, coveredUntil: new Date(NOW).toISOString() });
    // Days from the pool's creation day to yesterday; 40 USD on one of them.
    const created = rhcPoolCreatedAtSeconds(SPCX), createdDay = created - (created % 86_400);
    const days = Math.min(7, (today - 86_400 - createdDay) / 86_400 + 1);
    expect(days).toBeGreaterThanOrEqual(2);
    expect(rolled.profile.daily).toEqual({ avgDailyVolumeUsd: 40 / days, days });
  });

  it("ignores a saved profile for another token pair or algorithm", () => {
    const wrong = profile(POOLS[1]!);
    const old = { ...profile(SPCX), algorithmVersion: "old" };
    const plan = planRhcProfileFetches([SPCX], { [SPCX.poolId.toLowerCase()]: wrong }, NOW);
    expect(plan.get(SPCX.poolId.toLowerCase())).toEqual({ action: "fetch", cached: null });
    expect(planRhcProfileFetches([SPCX], { [SPCX.poolId.toLowerCase()]: old }, NOW).get(SPCX.poolId.toLowerCase()))
      .toEqual({ action: "fetch", cached: null });
  });
});

describe("fetchRhcMarketBatch (one call for all pools)", () => {
  it("uses one GeckoTerminal pools/multi call and one DexScreener call only for its gaps", async () => {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(url);
      return new URL(url).hostname.includes("geckoterminal") ? json({ data: [] }) : json(dexScreenerCapture);
    }) as unknown as typeof fetch;
    const { market, issues } = await fetchRhcMarketBatch({ fetcher, gate: gate(), signal: new AbortController().signal });
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/pools/multi/");
    expect(urls[1]!.split("/").at(-1)!.split(",")).toHaveLength(POOLS.length);
    expect([...market.keys()]).toEqual([SPCX.poolId.toLowerCase()]);
    expect(issues).toEqual([]);
  });

  it("skips DexScreener when GeckoTerminal covers every pool, and reports a 429 without retrying", async () => {
    const urls: string[] = [];
    const ok = (async (url: string) => { urls.push(url); return json({ data: [(geckoCapture as { data: unknown }).data] }); }) as unknown as typeof fetch;
    const { market } = await fetchRhcMarketBatch({ fetcher: ok, gate: gate(), signal: new AbortController().signal, pools: [SPCX] });
    expect(urls).toHaveLength(1);
    expect(market.get(SPCX.poolId.toLowerCase())).toMatchObject({ source: "geckoterminal" });

    const g = gate();
    const limited = (async (url: string) => new URL(url).hostname.includes("geckoterminal") ? json({}, 429) : json({}, 500)) as unknown as typeof fetch;
    const result = await fetchRhcMarketBatch({ fetcher: limited, gate: g, signal: new AbortController().signal, pools: [SPCX] });
    expect(result.market.size).toBe(0);
    expect(result.issues).toEqual(["GeckoTerminal pools/multi: HTTP 429", "DexScreener pairs: HTTP 500"]);
    expect(g.blockedForMs()).toBeGreaterThan(0);
  });
});

/** Prepare once, then refresh every RHC pool in order the way the cron queue does (stops at a 429). */
async function runAll(input: Parameters<typeof prepareRhcRun>[0]) {
  const rhc = await prepareRhcRun(input);
  const outcomes: string[] = [];
  for (const { spec } of rhc.pools) {
    const outcome = await rhc.refreshPool(spec);
    outcomes.push(outcome);
    if (outcome === "throttled") break;
  }
  return { ...rhc, outcomes, processed: outcomes.filter((o) => o === "saved" || o === "degraded").length };
}

describe("RHC pools in the APR queue (prepareRhcRun + refreshPool)", () => {
  it("saves a real reason for every pool whose inputs are missing (never a throttle error)", async () => {
    const base = { tick: 1, liquidity: "1", sqrtPriceX96: "79228162514264337593543950336", dynamicFeePips: { zeroForOne: 50, oneForZero: 51 }, estimatedApr: null };
    discovery.summaries = POOLS.map((spec, i) => ({
      ...base, poolId: spec.poolId, protocol: "uniswap-v4-rhc",
      ...(i === 0 ? { sqrtPriceX96: null } : i === 1 ? { dynamicFeePips: null } : {}),
    }));
    const calls: { op: string; data?: { poolId: string; issues: string[]; payload: unknown } }[] = [];
    const store: RwaStore = {
      request: (async (input: { op: string; data?: never }) => {
        calls.push(input);
        return input.op === "ensureRhcRoster" ? { pools: [], profiles: {}, refreshedAt: {} } : {};
      }) as never,
    };
    const fetcher = (async () => json({ data: [] })) as unknown as typeof fetch;
    const lease: Lease = { job: "rwa-apr-refresh", owner: "00000000-0000-4000-8000-000000000001", epoch: 1 };
    const result = await runAll({
      store, lease, fetcher, clock: () => NOW, signal: new AbortController().signal, client: {} as never, gate: gate(),
    });
    const saved = calls.filter((call) => call.op === "saveApr");
    expect(saved).toHaveLength(POOLS.length);
    expect(saved.every((call) => call.data!.payload === null)).toBe(true);
    const reasons = new Map(saved.map((call) => [call.data!.poolId, call.data!.issues[0]]));
    expect(reasons.get(POOLS[0]!.poolId.toLowerCase())).toBe("Pool state unavailable from Robinhood Chain RPC");
    expect(reasons.get(POOLS[1]!.poolId.toLowerCase())).toBe("StablePairHook fee unavailable from Robinhood Chain RPC");
    expect(reasons.get(POOLS[2]!.poolId.toLowerCase())).toBe("No TVL / 24h volume from GeckoTerminal or DexScreener");
    expect(calls.map((call) => call.op)[0]).toBe("ensureRhcRoster");
    expect(calls.some((call) => call.op === "prepareDaily")).toBe(false);
    expect(result.processed).toBe(0);
    expect(result.issues.some((issue) => /429|throttl/i.test(issue))).toBe(false);
  });

  const H = 3_600;
  const liveSummaries = () => POOLS.map((spec) => ({
    poolId: spec.poolId, protocol: "uniswap-v4-rhc", tick: 1, liquidity: "1", sqrtPriceX96: "79228162514264337593543950336",
    dynamicFeePips: { zeroForOne: 50, oneForZero: 51 }, protocolFee: 0, estimatedApr: { tvlUsd: 1000 },
  }));
  /** The captured SPCX GeckoTerminal row, re-addressed to every allowlisted pool (same token orientation). */
  const pricedGecko = (txns24h = 3) => {
    const row = (geckoCapture as { data: { attributes: Record<string, unknown>; relationships: Record<string, { data: { id: string } }> } }).data;
    const baseIsC0 = row.relationships.base_token!.data.id.endsWith(SPCX.currency0.address.toLowerCase());
    return { data: POOLS.map((spec) => {
      const [base, quote] = baseIsC0 ? [spec.currency0, spec.currency1] : [spec.currency1, spec.currency0];
      return {
        ...row, id: `robinhood_${spec.poolId.toLowerCase()}`,
        attributes: { ...row.attributes, address: spec.poolId.toLowerCase(),
          transactions: { h24: { buys: txns24h, sells: 0 } }, volume_usd: { h24: txns24h ? "36.6" : "0.0" } },
        relationships: { ...row.relationships,
          base_token: { data: { id: `robinhood_${base.address.toLowerCase()}`, type: "token" } },
          quote_token: { data: { id: `robinhood_${quote.address.toLowerCase()}`, type: "token" } } },
      };
    }) };
  };
  function harness(opts: { profiles?: Record<string, StoredProfile | null>; gecko?: unknown; stepMs?: number; ohlcvStatus?: number }) {
    discovery.summaries = liveSummaries();
    const saves: { poolId: string; payload: unknown; profile: StoredProfile | null; issues: string[] }[] = [];
    const store: RwaStore = {
      request: (async (input: { op: string; data?: never }) => {
        if (input.op === "saveApr") saves.push(input.data!);
        return input.op === "ensureRhcRoster" ? { pools: [], profiles: opts.profiles ?? {}, refreshedAt: {} } : {};
      }) as never,
    };
    let now = NOW;
    const urls: string[] = [];
    const nowS = Math.floor(NOW / 1000), today = nowS - (nowS % 86_400);
    const fetcher = (async (url: string) => {
      urls.push(url);
      now += opts.stepMs ?? 0;
      if (url.includes("/pools/multi/")) return json(opts.gecko ?? pricedGecko());
      if (url.includes("/ohlcv/")) {
        if (opts.ohlcvStatus) return json({}, opts.ohlcvStatus);
        const step = url.includes("/ohlcv/hour") ? H : 86_400;
        const spec = POOLS.find((pool) => url.toLowerCase().includes(pool.poolId.toLowerCase()))!;
        return json({
          data: { attributes: { ohlcv_list: Array.from({ length: 8 * 86_400 / step }, (_, i) => [today - (i + 1) * step, 1, 1, 1, 1, 2]) } },
          meta: { base: { address: spec.currency0.address }, quote: { address: spec.currency1.address } },
        });
      }
      return json({ pairs: [] });
    }) as unknown as typeof fetch;
    const lease: Lease = { job: "rwa-apr-refresh", owner: "00000000-0000-4000-8000-000000000001", epoch: 1 };
    const run = (g = gate()) => runAll({
      store, lease, fetcher, clock: () => now, signal: new AbortController().signal, client: {} as never, gate: g,
    });
    return { run, saves, urls, ohlcv: () => urls.filter((url) => url.includes("/ohlcv/")) };
  }

  it("makes one hourly OHLCV call per due pool on the run's gate and saves every pool", async () => {
    const h = harness({});
    const result = await h.run();
    expect(h.ohlcv()).toHaveLength(POOLS.length);
    expect(h.ohlcv().every((url) => url.includes("/ohlcv/hour"))).toBe(true);
    expect(result.stats).toEqual({ fetched: POOLS.length, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0 });
    expect(h.saves).toHaveLength(POOLS.length);
    expect(h.saves.every((save) => save.payload)).toBe(true);
    const saved = h.saves.find((save) => save.payload)!;
    expect(saved.profile!.profile.daily!.days).toBeGreaterThan(0);
    expect(saved.profile!.fetchState).toMatchObject({ failures: 0 });
    expect(result.processed).toBe(POOLS.length);
  });

  it("returns refreshedAt per pool from the roster (the queue key)", async () => {
    const h = harness({});
    const result = await h.run();
    expect(result.pools.map((pool) => pool.poolId)).toEqual(POOLS.map((spec) => spec.poolId.toLowerCase()));
    expect(result.pools.every((pool) => pool.refreshedAt === null)).toBe(true);
  });

  it("queue key falls back to the saved profile's last attempt / observation when the roster has none", async () => {
    const at = new Date(NOW - 5 * 3_600_000).toISOString();
    const profiles = { [SPCX.poolId.toLowerCase()]: profile(SPCX, { fetchState: { lastAttemptAt: at, failures: 1 } }) };
    const result = await harness({ profiles }).run();
    expect(result.pools.find((pool) => pool.spec === SPCX)!.refreshedAt).toBe(at);
  });

  it("reusing an earlier window's history during a fetch backoff is marked stale, aged by its covered time", async () => {
    const yesterday = volumeWindowEnd(NOW - 86_400_000);
    const covered = new Date(NOW - 30 * 3_600_000).toISOString();
    const profiles = Object.fromEntries(POOLS.map((spec) => [spec.poolId.toLowerCase(), profile(spec, {
      windowEndUtc: yesterday, observedAt: NOW - 30 * 3_600_000, hourlyAt: NOW - 30 * 3_600_000,
      fetchState: { lastAttemptAt: new Date(NOW - 3_600_000).toISOString(), failures: 1, coveredUntil: covered } })]));
    const h = harness({ profiles });
    const result = await h.run();
    expect(h.ohlcv()).toHaveLength(0);
    expect(result.stats).toMatchObject({ reused: POOLS.length, fetched: 0 });
    expect(h.saves).toHaveLength(POOLS.length);
    for (const save of h.saves) {
      expect(save.profile!.profile.stale).toBe(true);
      expect(save.profile!.profile.observedAt!.hourly).toBe(covered);
      expect(save.profile!.profile.issues).toContain("Using previously saved price history");
    }
    // A current-window history is reused as is (not stale).
    const current = harness({ profiles: Object.fromEntries(POOLS.map((spec) => [spec.poolId.toLowerCase(), profile(spec)])) });
    await current.run();
    expect(current.saves.every((save) => !save.profile!.profile.stale)).toBe(true);
  });

  it("withTimeout rejects a slow call (the RHC tick window read) after its limit or on abort", async () => {
    const never = new Promise<never>(() => undefined);
    await expect(withTimeout(never, 5, "Robinhood Chain tick window read timed out")).rejects.toThrow("Robinhood Chain tick window read timed out");
    const controller = new AbortController();
    const pending = withTimeout(never, 60_000, "x", controller.signal);
    controller.abort(new Error("job timeout"));
    await expect(pending).rejects.toThrow("job timeout");
    await expect(withTimeout(Promise.resolve(1), 5, "x")).resolves.toBe(1);
  });

  it("rolls quiet pools forward with no call, beside the fetches", async () => {
    const yesterday = volumeWindowEnd(NOW - 86_400_000);
    const profiles = Object.fromEntries(POOLS.map((spec) => [spec.poolId.toLowerCase(),
      profile(spec, { windowEndUtc: yesterday, observedAt: NOW - 24 * 3_600_000, hourlyAt: NOW - 24 * 3_600_000,
        candles: [{ time: Math.floor(NOW / 1000) - 30 * H, open: 1, high: 1, low: 1, close: 1, volume: 2 }] })]));
    const h = harness({ profiles, gecko: pricedGecko(0) });
    const result = await h.run();
    expect(h.ohlcv()).toHaveLength(0);
    expect(result.stats).toMatchObject({ fetched: 0, rolledForward: POOLS.length });
    expect(h.saves.every((save) => save.payload && save.profile!.windowEndUtc === volumeWindowEnd(NOW))).toBe(true);
  });

  it("on a 429 saves nothing for that pool and reports it throttled (it keeps its place in the queue)", async () => {
    const h = harness({ ohlcvStatus: 429 });
    const result = await h.run(new ThrottleGate({ minSpacingMs: 0, sleep: async () => undefined }));
    expect(result.outcomes).toEqual(["throttled"]);
    expect(h.ohlcv()).toHaveLength(1);
    expect(h.saves).toHaveLength(0);
  });

  it("records a failed fetch (backoff) and keeps the saved history", async () => {
    const yesterday = volumeWindowEnd(NOW - 86_400_000);
    const profiles = Object.fromEntries(POOLS.map((spec) => [spec.poolId.toLowerCase(), profile(spec, { windowEndUtc: yesterday, observedAt: NOW - 25 * 3_600_000 })]));
    const h = harness({ profiles, ohlcvStatus: 500 });
    const result = await h.run();
    expect(result.stats).toMatchObject({ failedFetches: POOLS.length, fetched: 0 });
    const failed = h.saves.filter((save) => save.profile?.fetchState?.failures === 1);
    expect(failed).toHaveLength(POOLS.length);
    expect(failed.every((save) => save.profile!.profile.stale && save.profile!.profile.daily!.avgDailyVolumeUsd === 10)).toBe(true);
    // The next runs: every failed pool waits out its backoff (keeps its saved history, no call).
    const next = planRhcProfileFetches(POOLS, Object.fromEntries(h.saves.map((save) => [save.poolId, save.profile])), NOW + 4 * 3_600_000);
    expect([...next.values()].every((row) => row.action === "reuse")).toBe(true);
    expect(h.saves).toHaveLength(POOLS.length);
    expect(h.saves.filter((save) => save.payload)).toHaveLength(POOLS.length);
  });
});
