import "@/lib/engine-host";
import "server-only";

import type { PublicClient } from "viem";
import { RHC_BLOCK_ANCHOR, UNIV4_RHC_ALLOWLISTED_POOLS, type Univ4AllowlistedPool } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { discoverUniv4RhcPools, type Univ4PoolSummary } from "@sofinance/engine/protocols/uniswap-v4/discovery";
import {
  dexScreenerPairsUrl, geckoTerminalPoolsMultiUrl, parseDexScreenerPairs, parseGeckoTerminalPools, type Univ4MarketData,
} from "@sofinance/engine/protocols/uniswap-v4/market-data";
import { hasPriceHistory, loadVolumeProfile, type VolumeProfile } from "./pool-range-apr";
import { averageDailyVolume, dailyVolumesFromHourly } from "./range-apr/daily-volume";
import { ThrottleGate } from "./range-apr/throttle-gate";
import { assembleRhcRangeApr, rhcEconomics, RHC_ECONOMICS_SOURCE, rhcLiquidityAt, rhcStateClient } from "./rhc-range-apr";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { ALGORITHM_VERSION, type Lease, type ProfileFetchState, type RwaStore, type StoredProfile } from "./rwa-store-types";

/**
 * Cron-only RHC pass (inside `rwa-apr-refresh`). The page reads what this saves and never calls an indexer or RPC.
 * Per run (one daily cron, 90 s job, GeckoTerminal ≤ 4 calls / min: calls start ≥ 16 s apart):
 * 1. one GeckoTerminal `/pools/multi` call for TVL, 24h volume and 24h trades of all 11 pools (one DexScreener
 *    batch call only for pools GeckoTerminal lacks);
 * 2. StateView / hook state per pool through multicall, then the tick window (two multicalls per pool);
 * 3. price history (7 complete UTC days): every pool whose saved history is not from today's window gets
 *    - rolled forward with no call when GeckoTerminal reports no trades in the last 24 h and the saved history
 *      already covers the time before that (the new day is a zero-volume day), or
 *    - ONE GeckoTerminal hourly-candle call (daily USD volume from the same candles: both tokens are the same
 *      stock), at most `RHC_MAX_PROFILE_FETCHES_PER_RUN`, only while the pass is inside its time budget.
 *    Fetch order is fair: missing history first, then the longest-waiting pool; a pool whose fetch failed goes
 *    to the back with an exponential backoff, so it cannot starve the others. A pool not fetched this run
 *    keeps its saved history with today's economics.
 * Pools that need no call are saved at once (beside the gated fetches), each pool as soon as it is done.
 */
export const RHC_GECKO_SPACING_MS = 16_000;
/** pools/multi + 4 OHLCV calls start at 0, 16, 32, 48, 64 s: never more than 4 in any 60 s. */
export const RHC_MAX_PROFILE_FETCHES_PER_RUN = 4;
/** No OHLCV call starts later than this after the pass began: the rest of the 90 s job saves results. */
export const RHC_FETCH_START_BUDGET_MS = 66_000;
export const RHC_PROFILE_MAX_AGE_MS = 6 * 3_600_000;
/** Roll-forward needs the saved history to reach back to (now − 24 h − this): GeckoTerminal's txns window is 24 h. */
export const RHC_QUIET_COVERAGE_SLACK_MS = 15 * 60_000;
export const RHC_FAILURE_BACKOFF_MS = 12 * 3_600_000;
export const RHC_FAILURE_BACKOFF_MAX_MS = 4 * 86_400_000;
/** Measured block rate (`RHC_BLOCK_ANCHOR`), for pool creation days. */
const RHC_BLOCKS_PER_SECOND = 9.6;

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

/** `fetch`: new OHLCV; `roll`: no trades since the saved history, roll it to today; `reuse`: keep the saved one. */
export type RhcProfileAction = "fetch" | "roll" | "reuse";
type Plan = { action: RhcProfileAction; cached: StoredProfile | null };

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

/** Backoff after `failures` consecutive failed fetches: 12 h, 24 h, 48 h, … up to 4 days. */
export function rhcFailureBackoffMs(failures: number): number {
  return failures <= 0 ? 0 : Math.min(RHC_FAILURE_BACKOFF_MAX_MS, RHC_FAILURE_BACKOFF_MS * 2 ** (failures - 1));
}

/** Trades are known up to here (last good fetch or no-trade check). */
function coveredUntil(cached: StoredProfile): number {
  const at = cached.fetchState?.coveredUntil ?? cached.profile.observedAt?.hourly ?? null;
  return at ? Date.parse(at) : Number.NEGATIVE_INFINITY;
}

/** No trades in GeckoTerminal's last 24 h and the saved history reaches back to that window. */
function isQuietSinceSaved(cached: StoredProfile, market: Univ4MarketData | undefined, nowMs: number): boolean {
  return !!market && market.txns24h === 0 && market.volume24hUsd === 0 && !cached.profile.stale
    && coveredUntil(cached) >= nowMs - 86_400_000 - RHC_QUIET_COVERAGE_SLACK_MS;
}

/**
 * Per pool: reuse, roll forward or fetch, and the order of the fetches (missing history first, then the pool
 * waiting longest; pools with failed fetches after all others, and not before their backoff ends).
 */
export function planRhcProfileFetches(
  pools: readonly Univ4AllowlistedPool[], profiles: Record<string, StoredProfile | null>, nowMs: number,
  market: ReadonlyMap<string, Univ4MarketData> = new Map(),
): { plan: Map<string, Plan>; fetchOrder: string[] } {
  const plan = new Map<string, Plan>();
  const due: { id: string; failures: number; priority: number; waitingSince: number }[] = [];
  for (const spec of pools) {
    const id = spec.poolId.toLowerCase();
    const cached = usableProfile(spec, profiles[id]);
    const priority = rhcProfilePriority(cached, nowMs);
    if (priority === 3) { plan.set(id, { action: "reuse", cached }); continue; }
    if (cached && priority > 0 && isQuietSinceSaved(cached, market.get(id), nowMs)) { plan.set(id, { action: "roll", cached }); continue; }
    const state = cached?.fetchState ?? profiles[id]?.fetchState;
    const failures = state?.failures ?? 0;
    const lastAttempt = state ? Date.parse(state.lastAttemptAt) : Number.NEGATIVE_INFINITY;
    // 1 h of slack: daily runs are ~24 h apart, not exactly.
    if (failures > 0 && nowMs < lastAttempt + rhcFailureBackoffMs(failures) - 3_600_000) { plan.set(id, { action: "reuse", cached }); continue; }
    plan.set(id, { action: "fetch", cached });
    due.push({ id, failures, priority, waitingSince: state ? lastAttempt : cached ? Date.parse(cached.observedAt) : Number.NEGATIVE_INFINITY });
  }
  due.sort((a, b) => Number(a.failures > 0) - Number(b.failures > 0) || a.priority - b.priority || a.waitingSince - b.waitingSince);
  return { plan, fetchOrder: due.map((row) => row.id) };
}

function storedFrom(fresh: VolumeProfile, nowMs: number, fetchState?: ProfileFetchState): StoredProfile {
  const stamps = [fresh.observedAt?.economics, fresh.observedAt?.daily, fresh.observedAt?.hourly]
    .filter((x): x is string => !!x).sort();
  return {
    algorithmVersion: ALGORITHM_VERSION, profile: fresh, windowEndUtc: volumeWindowEnd(nowMs),
    observedAt: stamps[0] ?? new Date(nowMs).toISOString(), ...(fetchState ? { fetchState } : {}),
  };
}

/** One USD price for either token (same stock on both sides); null when the market batch has none. */
export function rhcTokenPriceUsd(market: Univ4MarketData | undefined): number | null {
  const prices = [market?.priceUsd?.token0, market?.priceUsd?.token1].filter((p): p is number => !!p && Number.isFinite(p) && p > 0);
  return prices.length ? prices.reduce((sum, p) => sum + p, 0) / prices.length : null;
}

/** Pool creation time (from its Initialize block), so quiet first days count as zero-volume days. */
export function rhcPoolCreatedAtSeconds(spec: Univ4AllowlistedPool): number {
  return Math.floor(RHC_BLOCK_ANCHOR.timestamp + Number(spec.initBlock - RHC_BLOCK_ANCHOR.number) / RHC_BLOCKS_PER_SECOND);
}

/** Saved history moved to today's window: the days since it was fetched had no trades. */
export function rollRhcProfileForward(cached: StoredProfile, spec: Univ4AllowlistedPool, nowMs: number, priceUsd: number | null): StoredProfile {
  const nowSeconds = Math.floor(nowMs / 1000);
  const candles = cached.profile.candles ?? [];
  const daily = priceUsd
    ? averageDailyVolume(dailyVolumesFromHourly(candles, priceUsd), nowSeconds, undefined, rhcPoolCreatedAtSeconds(spec)) ?? cached.profile.daily
    : cached.profile.daily;
  return {
    ...cached, windowEndUtc: volumeWindowEnd(nowMs), observedAt: new Date(nowMs).toISOString(),
    profile: { ...cached.profile, daily },
    fetchState: { lastAttemptAt: cached.fetchState?.lastAttemptAt ?? cached.observedAt, failures: 0, coveredUntil: new Date(nowMs).toISOString() },
  };
}

/** Why a pool has no estimate when its summary lacks inputs (shown as the snapshot's reason). */
function missingInputs(summary: Univ4PoolSummary): string | null {
  if (!summary.sqrtPriceX96 || summary.tick === null || summary.liquidity === null) return "Pool state unavailable from Robinhood Chain RPC";
  if (!summary.dynamicFeePips) return "StablePairHook fee unavailable from Robinhood Chain RPC";
  if (!summary.estimatedApr) return "No TVL / 24h volume from GeckoTerminal or DexScreener";
  return null;
}

export type RhcAprRunStats = { fetched: number; rolledForward: number; reused: number; deferred: number; failedFetches: number };

export async function refreshRhcAprSnapshots(input: {
  store: RwaStore; lease: Lease; fetcher: Fetcher; clock: () => number; signal: AbortSignal;
  client?: PublicClient; gate?: ThrottleGate; maxProfileFetches?: number; fetchStartBudgetMs?: number;
}): Promise<{ processed: number; issues: string[]; stats: RhcAprRunStats }> {
  const { store, lease, fetcher, clock, signal } = input;
  const startedAt = clock();
  const client = input.client ?? rhcStateClient();
  const gate = input.gate ?? rhcGeckoGate();
  const maxFetches = input.maxProfileFetches ?? RHC_MAX_PROFILE_FETCHES_PER_RUN;
  const startBudget = input.fetchStartBudgetMs ?? RHC_FETCH_START_BUDGET_MS;
  const pools = UNIV4_RHC_ALLOWLISTED_POOLS;
  const issues: string[] = [];
  const stats: RhcAprRunStats = { fetched: 0, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0 };
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
  const { plan, fetchOrder } = planRhcProfileFetches(pools, roster.profiles, clock(), market);
  let fetchesLeft = maxFetches;
  const specById = new Map(pools.map((spec) => [spec.poolId.toLowerCase(), spec]));

  const refreshPool = async (spec: Univ4AllowlistedPool) => {
    const poolId = spec.poolId.toLowerCase();
    const summary = summaries.find((row) => row.poolId.toLowerCase() === poolId)!;
    const { action, cached } = plan.get(poolId)!;
    let stored: StoredProfile | null = null;
    const fail = async (message: string) => {
      issues.push(`${spec.baseSymbol}: ${message}`);
      // A price history fetched before the failure is still saved (progress), without a payload.
      if (!signal.aborted) await store.request({
        op: "saveApr", lease, data: { poolId, payload: null, profile: stored, chainObservedAt: null, issues: [message] },
      }).catch(() => undefined);
    };
    try {
      signal.throwIfAborted();
      await store.request({ op: "renew", lease });
      const missing = missingInputs(summary);
      if (missing) { await fail(missing); return; }
      const nowMs = clock(), nowSeconds = Math.floor(nowMs / 1000);
      const priceUsd = rhcTokenPriceUsd(market.get(poolId));
      const economics = rhcEconomics(spec, {
        feePips: summary.dynamicFeePips!, sqrtPriceX96: BigInt(summary.sqrtPriceX96!), protocolFee: summary.protocolFee,
      }, summary.estimatedApr!.tvlUsd, market.get(poolId)?.priceUsd);
      const withEconomics = (profile: StoredProfile): StoredProfile => ({ ...profile, profile: { ...profile.profile, economics } });
      if (action === "roll" && cached) { stored = withEconomics(rollRhcProfileForward(cached, spec, nowMs, priceUsd)); stats.rolledForward += 1; }
      else if (cached) stored = withEconomics(cached);
      // Calls this fetch makes; each must fit the per-run cap and start inside the time budget.
      const cost = priceUsd ? 1 : 2;
      const fits = () => cost <= fetchesLeft
        && clock() - startedAt + gate.nextStartInMs() + (cost - 1) * RHC_GECKO_SPACING_MS <= startBudget;
      if (action === "fetch" && fits()) {
        fetchesLeft -= cost;
        const fresh = await loadVolumeProfile(poolId, fetcher, nowSeconds, {
          economics: { ...RHC_ECONOMICS_SOURCE, load: async () => economics },
          network: "robinhood", gate, retry: { signal, attempts: 1 },
          // Without a token price this pool falls back to the separate daily-candle call.
          ...(priceUsd ? { dailyFromHourly: { tokenPriceUsd: priceUsd, createdAtSeconds: rhcPoolCreatedAtSeconds(spec) } } : {}),
        });
        const attemptAt = new Date(clock()).toISOString();
        const previous = (cached ?? roster.profiles[poolId])?.fetchState;
        if (hasPriceHistory(fresh)) {
          stored = storedFrom(fresh, nowMs, { lastAttemptAt: attemptAt, failures: 0, coveredUntil: fresh.observedAt?.hourly ?? attemptAt });
          stats.fetched += 1;
        } else {
          const fetchState: ProfileFetchState = { lastAttemptAt: attemptAt, failures: (previous?.failures ?? 0) + 1,
            ...(previous?.coveredUntil ? { coveredUntil: previous.coveredUntil } : {}) };
          stored = stored
            ? { ...stored, fetchState, profile: { ...stored.profile, stale: true, issues: [...fresh.issues, "Using previously saved price history"] } }
            : storedFrom(fresh, nowMs, fetchState);
          stats.failedFetches += 1;
        }
      } else if (action === "fetch") stats.deferred += 1;
      else if (action === "reuse") stats.reused += 1;
      if (!stored) {
        // No saved history yet and no OHLCV slot left this run: the next run fetches it first.
        await fail("Price history queued for the next refresh");
        return;
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
  };

  // Two lanes: gated price-history fetches in fair order, and every other pool at once (cheap RPC + save).
  const fetchLane = fetchOrder.map((id) => specById.get(id)!);
  const otherLane = pools.filter((spec) => !fetchOrder.includes(spec.poolId.toLowerCase()));
  await Promise.all([
    (async () => { for (const spec of fetchLane) await refreshPool(spec); })(),
    (async () => { for (const spec of otherLane) await refreshPool(spec); })(),
  ]);
  return { processed, issues, stats };
}

/** Test hook. */
export function resetRhcAprRefreshGate(): void {
  sharedGate = null;
}
