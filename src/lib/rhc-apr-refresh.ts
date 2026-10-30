import "@/lib/engine-host";
import "server-only";

import type { PublicClient } from "viem";
import { UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { discoverUniv4RhcPools, type Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import {
  dexScreenerPairsUrl, geckoTerminalPoolsMultiUrl, parseDexScreenerPairs, parseGeckoTerminalPools, type Univ4MarketData,
} from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { hasPriceHistory, loadVolumeProfile, type VolumeProfile } from "./pool-range-apr";
import { ThrottleGate } from "./range-apr/throttle-gate";
import { assembleRhcRangeApr, rhcEconomics, RHC_ECONOMICS_SOURCE, rhcLiquidityAt, rhcStateClient } from "./rhc-range-apr";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { ALGORITHM_VERSION, type Lease, type RwaStore, type StoredProfile } from "./rwa-store-types";

/**
 * Cron-only RHC pass (inside `rwa-apr-refresh`). The page reads what this saves and never calls an indexer or RPC.
 * Per run:
 * 1. one GeckoTerminal `/pools/multi` call for TVL + 24h volume of all 11 pools (one DexScreener batch call only
 *    for pools GeckoTerminal lacks);
 * 2. StateView / hook state per pool through multicall, then the tick window (two multicalls per pool);
 * 3. GeckoTerminal OHLCV (day + hour) for at most `profileFetches` pools whose saved price history is missing,
 *    from an older UTC day, or older than 6 h; every GeckoTerminal call is ≥16 s apart (under 4 per minute).
 *    Other pools reuse their saved price history with today's economics, so every pool gets a fresh snapshot.
 */
export const RHC_GECKO_SPACING_MS = 16_000;
export const RHC_PROFILE_FETCHES_PER_RUN = 2;
export const RHC_PROFILE_MAX_AGE_MS = 6 * 3_600_000;

let sharedGate: ThrottleGate | null = null;
const rhcGeckoGate = () =>
  (sharedGate ??= new ThrottleGate({ minSpacingMs: RHC_GECKO_SPACING_MS, defaultCooldownMs: 60_000, maxCooldownMs: 120_000 }));

type Fetcher = typeof fetch;

async function getJson(fetcher: Fetcher, url: string, signal: AbortSignal) {
  const response = await fetcher(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  return { status: response.status, body: response.ok ? ((await response.json()) as unknown) : null };
}

/** TVL / 24h volume for every allowlisted pool from one GeckoTerminal call (+ one DexScreener call for gaps). */
export async function fetchRhcMarketBatch(input: {
  fetcher: Fetcher; gate: ThrottleGate; signal: AbortSignal; pools?: readonly Univ4AllowlistedPool[];
}): Promise<{ market: Map<string, Univ4MarketData>; issues: string[] }> {
  const pools = input.pools ?? UNIV4_RHC_ALLOWLISTED_POOLS;
  const issues: string[] = [];
  let market = new Map<string, Univ4MarketData>();
  const ids = pools.map((pool) => pool.poolId);
  const gecko = await input.gate.run(() => getJson(input.fetcher, geckoTerminalPoolsMultiUrl(ids), input.signal))
    .catch(() => ({ value: { status: 0, body: null } }));
  if ("value" in gecko) {
    if (gecko.value.status === 429) input.gate.block();
    if (gecko.value.body) market = parseGeckoTerminalPools(gecko.value.body, pools);
    else issues.push(`GeckoTerminal pools/multi: HTTP ${gecko.value.status || "error"}`);
  } else issues.push("GeckoTerminal pools/multi: cooling down after 429");
  const missing = pools.filter((pool) => !market.has(pool.poolId.toLowerCase()));
  if (missing.length) {
    const dex = await getJson(input.fetcher, dexScreenerPairsUrl(missing.map((pool) => pool.poolId)), input.signal)
      .catch(() => ({ status: 0, body: null }));
    if (dex.body) for (const [id, row] of parseDexScreenerPairs(dex.body, missing)) market.set(id, row);
    else issues.push(`DexScreener pairs: HTTP ${dex.status || "error"}`);
  }
  return { market, issues };
}

type Plan = { fetch: boolean; cached: StoredProfile | null };

function usableProfile(spec: Univ4AllowlistedPool, cached: StoredProfile | null | undefined): StoredProfile | null {
  if (!cached || cached.algorithmVersion !== ALGORITHM_VERSION) return null;
  const economics = cached.profile.economics;
  return economics.mintA.toLowerCase() === spec.currency0.address.toLowerCase()
    && economics.mintB.toLowerCase() === spec.currency1.address.toLowerCase() ? cached : null;
}

/** 0 = no usable history, 1 = older UTC window, 2 = older than 6 h / stale, 3 = current. */
export function rhcProfilePriority(cached: StoredProfile | null, nowMs: number): number {
  if (!cached || !hasPriceHistory(cached.profile)) return 0;
  if (cached.windowEndUtc !== volumeWindowEnd(nowMs)) return 1;
  if (cached.profile.stale || nowMs - Date.parse(cached.observedAt) >= RHC_PROFILE_MAX_AGE_MS) return 2;
  return 3;
}

/** Which pools get new OHLCV this run: highest need first, oldest first, at most `budget`. */
export function planRhcProfileFetches(
  pools: readonly Univ4AllowlistedPool[], profiles: Record<string, StoredProfile | null>, nowMs: number, budget: number,
): Map<string, Plan> {
  const rows = pools.map((spec) => {
    const id = spec.poolId.toLowerCase();
    const cached = usableProfile(spec, profiles[id]);
    return { id, cached, priority: rhcProfilePriority(cached, nowMs), at: cached ? Date.parse(cached.observedAt) : 0 };
  });
  const order = [...rows].filter((row) => row.priority < 3).sort((a, b) => a.priority - b.priority || a.at - b.at);
  const chosen = new Set(order.slice(0, Math.max(0, budget)).map((row) => row.id));
  return new Map(rows.map((row) => [row.id, { fetch: chosen.has(row.id), cached: row.cached }]));
}

function storedFrom(fresh: VolumeProfile, nowMs: number): StoredProfile {
  const stamps = [fresh.observedAt?.economics, fresh.observedAt?.daily, fresh.observedAt?.hourly]
    .filter((x): x is string => !!x).sort();
  return { algorithmVersion: ALGORITHM_VERSION, profile: fresh, windowEndUtc: volumeWindowEnd(nowMs), observedAt: stamps[0] ?? new Date(nowMs).toISOString() };
}

/** Why a pool has no estimate when its summary lacks inputs (shown as the snapshot's reason). */
function missingInputs(summary: Univ4PoolSummary): string | null {
  if (!summary.sqrtPriceX96 || summary.tick === null || summary.liquidity === null) return "Pool state unavailable from Robinhood Chain RPC";
  if (!summary.dynamicFeePips) return "StablePairHook fee unavailable from Robinhood Chain RPC";
  if (!summary.estimatedApr) return "No TVL / 24h volume from GeckoTerminal or DexScreener";
  return null;
}

export async function refreshRhcAprSnapshots(input: {
  store: RwaStore; lease: Lease; fetcher: Fetcher; clock: () => number; signal: AbortSignal;
  client?: PublicClient; gate?: ThrottleGate; profileFetches?: number;
}): Promise<{ processed: number; issues: string[] }> {
  const { store, lease, fetcher, clock, signal } = input;
  const client = input.client ?? rhcStateClient();
  const gate = input.gate ?? rhcGeckoGate();
  const pools = UNIV4_RHC_ALLOWLISTED_POOLS;
  const issues: string[] = [];
  let processed = 0;

  const { market, issues: marketIssues } = await fetchRhcMarketBatch({ fetcher, gate, signal, pools });
  issues.push(...marketIssues.map((issue) => `RHC market: ${issue}`));
  signal.throwIfAborted();
  const summaries = await discoverUniv4RhcPools({
    clients: { state: client }, pools, marketData: async (spec) => market.get(spec.poolId.toLowerCase()) ?? null,
  });
  signal.throwIfAborted();
  const roster = await store.request({
    op: "ensureRhcRoster", lease,
    data: summaries.map((summary) => ({ poolId: summary.poolId.toLowerCase(), summary })),
  });
  // The daily history roster (rwa_apr_daily) picks up RHC pools once their feed is published this run.
  await store.request({ op: "prepareDaily", lease });
  const plan = planRhcProfileFetches(pools, roster.profiles, clock(), input.profileFetches ?? RHC_PROFILE_FETCHES_PER_RUN);
  // Pools that need OHLCV go first so their (gated, slow) calls start while the rest are cheap.
  const ordered = [...pools].sort((a, b) =>
    Number(plan.get(b.poolId.toLowerCase())!.fetch) - Number(plan.get(a.poolId.toLowerCase())!.fetch));

  for (const spec of ordered) {
    const poolId = spec.poolId.toLowerCase();
    const summary = summaries.find((row) => row.poolId.toLowerCase() === poolId)!;
    const { fetch: needsFetch, cached } = plan.get(poolId)!;
    const fail = async (message: string) => {
      issues.push(`${spec.baseSymbol}: ${message}`);
      if (!signal.aborted) await store.request({
        op: "saveApr", lease, data: { poolId, payload: null, profile: null, chainObservedAt: null, issues: [message] },
      }).catch(() => undefined);
    };
    try {
      signal.throwIfAborted();
      await store.request({ op: "renew", lease });
      const missing = missingInputs(summary);
      if (missing) { await fail(missing); continue; }
      const nowMs = clock(), nowSeconds = Math.floor(nowMs / 1000);
      const economics = rhcEconomics(spec, {
        feePips: summary.dynamicFeePips!, sqrtPriceX96: BigInt(summary.sqrtPriceX96!), protocolFee: summary.protocolFee,
      }, summary.estimatedApr!.tvlUsd);
      let stored: StoredProfile | null = cached ? { ...cached, profile: { ...cached.profile, economics } } : null;
      if (needsFetch) {
        const fresh = await loadVolumeProfile(poolId, fetcher, nowSeconds, {
          economics: { ...RHC_ECONOMICS_SOURCE, load: async () => economics },
          network: "robinhood", gate, retry: { signal, attempts: 1 },
        });
        if (hasPriceHistory(fresh) || !stored) stored = storedFrom(fresh, nowMs);
        else stored = { ...stored, profile: { ...stored.profile, stale: true,
          issues: [...fresh.issues, "Using previously saved price history"] } };
      }
      if (!stored) {
        // No saved history yet and no OHLCV slot left this run: the next run fetches it first.
        await fail("Price history queued for the next refresh");
        continue;
      }
      const chainObservedAt = new Date(clock()).toISOString();
      const chain = await rhcLiquidityAt(client, spec, {
        tick: summary.tick!, sqrtPriceX96: BigInt(summary.sqrtPriceX96!), liquidity: BigInt(summary.liquidity!),
      });
      const payload = assembleRhcRangeApr(poolId, stored.profile, chain, nowSeconds);
      payload.sample.windowEndUtc = stored.windowEndUtc;
      payload.sample.windowStartUtc = new Date(Date.parse(stored.windowEndUtc) - payload.sample.days * 86_400_000).toISOString();
      signal.throwIfAborted();
      await store.request({
        op: "saveApr", lease,
        data: { poolId, payload, profile: stored, chainObservedAt, issues: payload.sample.issues.slice(0, 20) },
      });
      processed += 1;
      if (payload.sample.degraded) issues.push(`${spec.baseSymbol}: Price history unavailable`);
    } catch (error) {
      await fail(sanitizePublicError(error, "RHC APR refresh failed").slice(0, 400));
    }
  }
  return { processed, issues };
}

/** Test hook. */
export function resetRhcAprRefreshGate(): void {
  sharedGate = null;
}
