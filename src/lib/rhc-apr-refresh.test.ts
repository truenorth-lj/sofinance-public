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
import { ThrottleGate } from "./range-apr/throttle-gate";
import {
  fetchRhcMarketBatch, planRhcProfileFetches, refreshRhcAprSnapshots, rhcProfilePriority, RHC_PROFILE_MAX_AGE_MS,
} from "./rhc-apr-refresh";
import { volumeWindowEnd } from "./rwa-daily";
import { ALGORITHM_VERSION, type Lease, type RwaStore, type StoredProfile } from "./rwa-store-types";

const POOLS = UNIV4_RHC_ALLOWLISTED_POOLS;
const SPCX = POOLS[0]!;
const NOW = Date.parse("2026-10-30T08:00:00Z");
const gate = () => new ThrottleGate({ minSpacingMs: 0, sleep: async () => undefined });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function profile(spec: (typeof POOLS)[number], over: { observedAt?: number; windowEndUtc?: string; candles?: unknown[] | null; stale?: boolean } = {}): StoredProfile {
  return {
    algorithmVersion: ALGORITHM_VERSION,
    windowEndUtc: over.windowEndUtc ?? volumeWindowEnd(NOW),
    observedAt: new Date(over.observedAt ?? NOW - 60_000).toISOString(),
    profile: {
      economics: { mintA: spec.currency0.address, mintB: spec.currency1.address } as never,
      daily: { avgDailyVolumeUsd: 10, days: 7 }, candles: (over.candles === undefined ? [{}] : over.candles) as never,
      sources: [], issues: [], stale: over.stale,
    },
  };
}

describe("RHC cron profile planning (OHLCV budget per run)", () => {
  it("ranks missing < older UTC window < old/stale < current", () => {
    expect(rhcProfilePriority(null, NOW)).toBe(0);
    expect(rhcProfilePriority(profile(SPCX, { candles: null }), NOW)).toBe(0);
    expect(rhcProfilePriority(profile(SPCX, { windowEndUtc: volumeWindowEnd(NOW - 86_400_000) }), NOW)).toBe(1);
    expect(rhcProfilePriority(profile(SPCX, { observedAt: NOW - RHC_PROFILE_MAX_AGE_MS }), NOW)).toBe(2);
    expect(rhcProfilePriority(profile(SPCX, { stale: true }), NOW)).toBe(2);
    expect(rhcProfilePriority(profile(SPCX), NOW)).toBe(3);
  });

  it("fetches at most `budget` pools, most-needed and oldest first, and reuses the rest", () => {
    const profiles: Record<string, StoredProfile | null> = {};
    for (const spec of POOLS) profiles[spec.poolId.toLowerCase()] = profile(spec);
    profiles[POOLS[3]!.poolId.toLowerCase()] = null;
    profiles[POOLS[5]!.poolId.toLowerCase()] = profile(POOLS[5]!, { observedAt: NOW - 7 * 3_600_000 });
    profiles[POOLS[6]!.poolId.toLowerCase()] = profile(POOLS[6]!, { observedAt: NOW - 9 * 3_600_000 });
    const plan = planRhcProfileFetches(POOLS, profiles, NOW, 2);
    const fetched = POOLS.filter((spec) => plan.get(spec.poolId.toLowerCase())!.fetch).map((spec) => spec.baseSymbol);
    expect(fetched).toEqual([POOLS[3]!.baseSymbol, POOLS[6]!.baseSymbol]);
    expect(plan.get(POOLS[0]!.poolId.toLowerCase())!.cached).not.toBeNull();
    expect(plan.size).toBe(POOLS.length);
  });

  it("ignores a saved profile for another token pair or algorithm", () => {
    const wrong = profile(POOLS[1]!);
    const old = { ...profile(SPCX), algorithmVersion: "old" };
    const plan = planRhcProfileFetches([SPCX], { [SPCX.poolId.toLowerCase()]: wrong }, NOW, 0);
    expect(plan.get(SPCX.poolId.toLowerCase())).toEqual({ fetch: false, cached: null });
    expect(planRhcProfileFetches([SPCX], { [SPCX.poolId.toLowerCase()]: old }, NOW, 1).get(SPCX.poolId.toLowerCase()))
      .toEqual({ fetch: true, cached: null });
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

describe("refreshRhcAprSnapshots", () => {
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
        return input.op === "ensureRhcRoster" ? { pools: [], profiles: {} } : {};
      }) as never,
    };
    const fetcher = (async () => json({ data: [] })) as unknown as typeof fetch;
    const lease: Lease = { job: "rwa-apr-refresh", owner: "00000000-0000-4000-8000-000000000001", epoch: 1 };
    const result = await refreshRhcAprSnapshots({
      store, lease, fetcher, clock: () => NOW, signal: new AbortController().signal, client: {} as never, gate: gate(),
    });
    const saved = calls.filter((call) => call.op === "saveApr");
    expect(saved).toHaveLength(POOLS.length);
    expect(saved.every((call) => call.data!.payload === null)).toBe(true);
    const reasons = new Map(saved.map((call) => [call.data!.poolId, call.data!.issues[0]]));
    expect(reasons.get(POOLS[0]!.poolId.toLowerCase())).toBe("Pool state unavailable from Robinhood Chain RPC");
    expect(reasons.get(POOLS[1]!.poolId.toLowerCase())).toBe("StablePairHook fee unavailable from Robinhood Chain RPC");
    expect(reasons.get(POOLS[2]!.poolId.toLowerCase())).toBe("No TVL / 24h volume from GeckoTerminal or DexScreener");
    expect(calls.map((call) => call.op).slice(0, 2)).toEqual(["ensureRhcRoster", "prepareDaily"]);
    expect(result.processed).toBe(0);
    expect(result.issues.some((issue) => /429|throttl/i.test(issue))).toBe(false);
  });
});
