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
import type { ThrottleGate } from "./range-apr/throttle-gate";
import { assembleRhcRangeApr, rhcEconomics, RHC_ECONOMICS_SOURCE, rhcLiquidityAt, rhcStateClient } from "./rhc-range-apr";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { ALGORITHM_VERSION, type Lease, type ProfileFetchState, type RwaStore, type StoredProfile } from "./rwa-store-types";

/**
 * Cron-only RHC part of `rwa-apr-refresh`. The page reads what this saves and never calls an indexer or RPC.
 * `prepareRhcRun` runs once per cron run, `refreshPool` once per RHC pool the run's oldest-first queue selects
 * (`rwa-refresh.ts`; Solana and RHC pools share that queue and its one GeckoTerminal gate, one call at a time):
 * 1. prepare: one GeckoTerminal `/pools/multi` call for TVL, 24h volume and 24h trades of all 11 pools (one
 *    DexScreener batch call only for pools GeckoTerminal lacks), StateView / hook state per pool through
 *    multicall, and the roster upsert (returns each pool's saved price history and when it was last refreshed);
 * 2. per pool: the tick window (two multicalls) and price history (7 complete UTC days). A pool whose saved history
 *    is not from today's window gets
 *    - rolled forward with no call when GeckoTerminal reports no trades in the last 24 h and the saved history
 *      already covers the time before that (the new day is a zero-volume day), or
 *    - ONE GeckoTerminal hourly-candle call (daily USD volume from the same candles: both tokens are the same
 *      stock; two calls without a token price), unless an earlier fetch failed and its backoff is still running.
 *    A pool whose fetch hit a 429 is not saved (`throttled`): the queue ends the run and it goes first next run.
 */
export const RHC_PROFILE_MAX_AGE_MS = 6 * 3_600_000;
/** Roll-forward needs the saved history to reach back to (now − 24 h − this): GeckoTerminal's txns window is 24 h. */
export const RHC_QUIET_COVERAGE_SLACK_MS = 15 * 60_000;
export const RHC_FAILURE_BACKOFF_MS = 12 * 3_600_000;
export const RHC_FAILURE_BACKOFF_MAX_MS = 4 * 86_400_000;
/** Measured block rate (`RHC_BLOCK_ANCHOR`), for pool creation days. */
const RHC_BLOCKS_PER_SECOND = 9.6;

type Fetcher = typeof fetch;

/** The per-pool tick window read (two multicalls) gives up after this, so one slow RPC cannot hold the queue. */
export const RHC_LIQUIDITY_TIMEOUT_MS = 10_000;

/** Rejects with `message` after `ms` (or when `signal` aborts); the slow call is left to settle on its own. */
export function withTimeout<T>(work: Promise<T>, ms: number, message: string, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    onAbort = () => reject(signal!.reason ?? new Error(message));
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, stop]).finally(() => {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  });
}

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
 * Per pool: reuse, roll forward or fetch. A pool whose fetches failed keeps its saved history (`reuse`) until its
 * backoff ends, so it cannot spend the run's GeckoTerminal calls every run.
 */
export function planRhcProfileFetches(
  pools: readonly Univ4AllowlistedPool[], profiles: Record<string, StoredProfile | null>, nowMs: number,
  market: ReadonlyMap<string, Univ4MarketData> = new Map(),
): Map<string, Plan> {
  const plan = new Map<string, Plan>();
  for (const spec of pools) {
    const id = spec.poolId.toLowerCase();
    const cached = usableProfile(spec, profiles[id]);
    const priority = rhcProfilePriority(cached, nowMs);
    if (priority === 3) { plan.set(id, { action: "reuse", cached }); continue; }
    if (cached && priority > 0 && isQuietSinceSaved(cached, market.get(id), nowMs)) { plan.set(id, { action: "roll", cached }); continue; }
    const state = cached?.fetchState ?? profiles[id]?.fetchState;
    const failures = state?.failures ?? 0;
    const lastAttempt = state ? Date.parse(state.lastAttemptAt) : Number.NEGATIVE_INFINITY;
    // 1 h of slack: runs are 4 h apart, not exactly.
    if (failures > 0 && nowMs < lastAttempt + rhcFailureBackoffMs(failures) - 3_600_000) { plan.set(id, { action: "reuse", cached }); continue; }
    plan.set(id, { action: "fetch", cached });
  }
  return plan;
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

/** `deferred`: RHC pools the run's queue did not reach (oldest-first: they go first next run). */
export type RhcAprRunStats = { fetched: number; rolledForward: number; reused: number; deferred: number; failedFetches: number };
/** saved: estimate saved; degraded / failed: saved without a fresh estimate; throttled: 429, nothing saved. */
export type RhcPoolOutcome = "saved" | "degraded" | "failed" | "throttled";
export type RhcRun = {
  /** Every allowlisted pool with when its APR was last refreshed or attempted (null = never): the queue key. */
  pools: { spec: Univ4AllowlistedPool; poolId: string; refreshedAt: string | null }[];
  refreshPool: (spec: Univ4AllowlistedPool) => Promise<RhcPoolOutcome>;
  /** Issues so far (prepare + every refreshed pool). */
  issues: string[];
  stats: RhcAprRunStats;
};

/** Once per cron run: market batch, pool state and roster (see the module comment). */
export async function prepareRhcRun(input: {
  store: RwaStore; lease: Lease; fetcher: Fetcher; clock: () => number; signal: AbortSignal;
  /** The run's one GeckoTerminal gate (shared with the Solana pools). */
  gate: ThrottleGate;
  client?: PublicClient;
}): Promise<RhcRun> {
  const { store, lease, fetcher, clock, signal, gate } = input;
  const client = input.client ?? rhcStateClient();
  const pools = UNIV4_RHC_ALLOWLISTED_POOLS;
  const issues: string[] = [];
  const stats: RhcAprRunStats = { fetched: 0, rolledForward: 0, reused: 0, deferred: 0, failedFetches: 0 };

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
  const plan = planRhcProfileFetches(pools, roster.profiles, clock(), market);

  const refreshPool = async (spec: Univ4AllowlistedPool): Promise<RhcPoolOutcome> => {
    const poolId = spec.poolId.toLowerCase();
    const summary = summaries.find((row) => row.poolId.toLowerCase() === poolId)!;
    const { action, cached } = plan.get(poolId)!;
    let stored: StoredProfile | null = null;
    const fail = async (message: string): Promise<RhcPoolOutcome> => {
      issues.push(`${spec.baseSymbol}: ${message}`);
      // A price history fetched before the failure is still saved (progress), without a payload.
      if (!signal.aborted) await store.request({
        op: "saveApr", lease, data: { poolId, payload: null, profile: stored, chainObservedAt: null, issues: [message] },
      }).catch(() => undefined);
      return "failed";
    };
    try {
      signal.throwIfAborted();
      await store.request({ op: "renew", lease });
      const missing = missingInputs(summary);
      if (missing) return await fail(missing);
      const nowMs = clock(), nowSeconds = Math.floor(nowMs / 1000);
      const priceUsd = rhcTokenPriceUsd(market.get(poolId));
      const economics = rhcEconomics(spec, {
        feePips: summary.dynamicFeePips!, sqrtPriceX96: BigInt(summary.sqrtPriceX96!), protocolFee: summary.protocolFee,
      }, summary.estimatedApr!.tvlUsd, market.get(poolId)?.priceUsd);
      const withEconomics = (profile: StoredProfile): StoredProfile => ({ ...profile, profile: { ...profile.profile, economics } });
      if (action === "roll" && cached) { stored = withEconomics(rollRhcProfileForward(cached, spec, nowMs, priceUsd)); stats.rolledForward += 1; }
      else if (cached) {
        // Saved history from an earlier UTC window (reused while a failed fetch backs off, or before a fetch that
        // then fails): an estimate from saved price history, so `priceHistoryStale` ("Data delayed", "—" once the
        // history is over 48h old) instead of looking fresh because the chain read is new.
        // Its age is how far trades are known (`coveredUntil`: the last good fetch or a later no-trade roll-forward).
        const earlierWindow = cached.windowEndUtc !== volumeWindowEnd(nowMs);
        const known = coveredUntil(cached);
        stored = withEconomics(earlierWindow && !cached.profile.stale
          ? { ...cached, profile: { ...cached.profile, stale: true, issues: [...cached.profile.issues, "Using previously saved price history"],
            observedAt: { economics: cached.profile.observedAt?.economics ?? cached.observedAt, daily: cached.profile.observedAt?.daily ?? null,
              hourly: Number.isFinite(known) ? new Date(known).toISOString() : (cached.profile.observedAt?.hourly ?? cached.observedAt) } } }
          : cached);
      }
      if (action === "fetch") {
        const fresh = await loadVolumeProfile(poolId, fetcher, nowSeconds, {
          economics: { ...RHC_ECONOMICS_SOURCE, load: async () => economics },
          network: "robinhood", gate, retry: { signal, attempts: 1 },
          // Without a token price this pool falls back to the separate daily-candle call.
          ...(priceUsd ? { dailyFromHourly: { tokenPriceUsd: priceUsd, createdAtSeconds: rhcPoolCreatedAtSeconds(spec) } } : {}),
        });
        // A 429 (now or earlier in the run): save nothing, so the pool keeps its place at the front of the queue.
        if (gate.hit429) return "throttled";
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
      } else if (action === "reuse") stats.reused += 1;
      // No saved history and its fetch is in backoff: the next run after the backoff fetches it.
      if (!stored) return await fail("Price history queued for the next refresh");
      const chainObservedAt = new Date(clock()).toISOString();
      const chain = await withTimeout(rhcLiquidityAt(client, spec, {
        tick: summary.tick!, sqrtPriceX96: BigInt(summary.sqrtPriceX96!), liquidity: BigInt(summary.liquidity!),
      }), RHC_LIQUIDITY_TIMEOUT_MS, "Robinhood Chain tick window read timed out", signal);
      const payload = assembleRhcRangeApr(poolId, stored.profile, chain, nowSeconds);
      payload.sample.windowEndUtc = stored.windowEndUtc;
      payload.sample.windowStartUtc = new Date(Date.parse(stored.windowEndUtc) - payload.sample.days * 86_400_000).toISOString();
      signal.throwIfAborted();
      await store.request({
        op: "saveApr", lease,
        data: { poolId, payload, profile: stored, chainObservedAt, issues: payload.sample.issues.slice(0, 20) },
      });
      if (payload.sample.degraded) { issues.push(`${spec.baseSymbol}: Price history unavailable`); return "degraded"; }
      return "saved";
    } catch (error) {
      return fail(sanitizePublicError(error, "RHC APR refresh failed").slice(0, 400));
    }
  };

  return {
    pools: pools.map((spec) => {
      const poolId = spec.poolId.toLowerCase();
      const saved = roster.profiles[poolId];
      // Falls back to the saved profile's last attempt / observation, never to pool id order alone.
      return { spec, poolId, refreshedAt: roster.refreshedAt[poolId] ?? saved?.fetchState?.lastAttemptAt ?? saved?.observedAt ?? null };
    }),
    refreshPool, issues, stats,
  };
}
