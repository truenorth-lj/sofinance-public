import "@/lib/engine-host";
import "server-only";
import type { PublicClient } from "viem";
import { getRwaConfig } from "./config/rwa-env";
import { discoverRwaPairs } from "./rwa-pairs";
import {
  assemblePoolRangeApr,
  hasPriceHistory,
  loadVolumeProfile,
  type VolumeProfile,
} from "./pool-range-apr";
import { readOnchainPoolLiquidity } from "./range-apr/onchain-liquidity";
import type { ThrottleGate } from "./range-apr/throttle-gate";
import { createCronGeckoGate } from "./pool-metrics/gecko";
import { SAVED_PRICE_HISTORY_MAX_AGE_MS } from "./rwa-freshness";
import { rpcConnection } from "@sofinance/engine/rpc";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { getRwaStore } from "./rwa-store";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { isRhcApr7dEnabled } from "./protocol-flags";
import { prepareRhcRun, type RhcAprRunStats, type RhcRun } from "./rhc-apr-refresh";
import { discoverRhcRegistryPools, rhcDiscoveryFindings, type RhcDiscoveryResult } from "./pool-metrics/rhc-discovery";
import { rhcStateClient } from "./rhc-range-apr";
import { captureRhcDiscoveryFindings } from "./sentry/capture";
import { resolveTokenIcons, rhcIconSources, solanaIconSources } from "./token-icons/resolve";
import type { RwaPairRow } from "./rwa-pairs";
import {
  ALGORITHM_VERSION,
  type ActivePool,
  type DiscoveryWrite,
  type JobName,
  type Lease,
  type RwaStore,
  type StoredProfile,
} from "./rwa-store-types";

type Options = {
  store?: RwaStore;
  force?: boolean;
  fetcher?: typeof fetch;
  clock?: () => number;
  /** Robinhood Chain state client for the registry discovery (tests). */
  rhcClient?: PublicClient;
  /** Absolute time (ms, `clock`) by which the whole invocation must be done (the route's `maxDuration`). */
  deadlineMs?: number;
  /** The run's shared GeckoTerminal gate (tests pass one with a fake clock). */
  geckoGate?: ThrottleGate;
};

/**
 * Vercel `maxDuration` of `/api/internal/rwa-refresh` (the route exports the same literal; tested). Discovery and
 * the APR job together must finish inside it, so the APR job's budget is clamped to what is left of it.
 */
export const RWA_REFRESH_MAX_DURATION_MS = 300_000;
/** 20% of `maxDuration` kept free: the whole invocation (discovery + APR) is budgeted to 240 s. */
export const RWA_REFRESH_DEADLINE_SLACK_MS = 60_000;
/** No pool is started inside this last part of the APR job: `prepareDaily`, `finish` and the response. */
export const APR_SAVE_RESERVE_MS = 10_000;
/**
 * Worst-case time for one queued pool, measured. Solana: 2 GeckoTerminal calls (day + hour candles) started 2.5 s
 * apart on the cron gate (`CRON_GECKO_SPACING_MS`), latency 0.41 s median / 0.69 s max (10/31, local), beside one
 * RPC liquidity read, then one save: ~5 s per pool (prod 10/30: 18 pools saved in 43 s at 2 lanes ≈ 4.8 s/pool/
 * lane). RHC: 1 call (2 without a token price) + two multicalls + save: ≤ 5 s. Budget 6 s.
 */
export const APR_POOL_BUDGET_MS = 6_000;
/** Fixed APR-job time before the queue, measured 10/31: RHC pools/multi + state multicalls + roster ≈ 10 s. */
export const APR_QUEUE_FIXED_MS = 15_000;
/**
 * Pools refreshed per cron run (Solana + RHC, one oldest-first queue, one GeckoTerminal call at a time).
 * Time: the invocation is budgeted to 80% of maxDuration = 240 s; discovery is capped at its 90 s job timeout, so
 * the APR job has ≥ 150 s; minus the fixed 15 s that leaves 135 s / 6 s per pool = 22 pools.
 * Rate: 22 pools × ≤ 2 calls + 1 pools/multi = ≤ 45 calls, started ≥ 2.5 s apart = ≤ 24 calls/min < ~30/min.
 * Coverage: 29 active pools (18 Solana + 11 RHC, 10/31) at 22 per run, 6 runs/day (every 4 h): every pool is
 * refreshed at least every ceil(29 / 22) = 2 runs = 8 h, and still within 24 h after up to 3 runs in a row end
 * early on a 429 (5 runs = 20 h); tested. The time guard (`APR_POOL_BUDGET_MS`) stops earlier if a run is slower.
 */
export const APR_POOLS_PER_RUN = 22;

/** fresh: today's price history; stale: computed from saved history; degraded/error: no estimate saved; throttled: 429, nothing saved. */
type PoolOutcome = "fresh" | "stale" | "degraded" | "error" | "throttled";
type JobResult = {
  job: JobName;
  status: "skipped" | "ok" | "partial" | "error";
  processed: number;
  issues: string[];
  elapsedMs?: number;
  /** rwa-discovery: Robinhood Chain registry check (hidden candidates for review; never shown). */
  rhcDiscovery?: RhcDiscoveryResult | { error: string };
  /** rwa-apr-refresh: what the RHC pools did with price histories this run. */
  rhc?: RhcAprRunStats;
  /** rwa-apr-refresh: the oldest-first queue (all active pools, how many this run selected / finished). */
  queue?: AprQueueStats;
};
export type AprQueueStats = { pools: number; selected: number; done: number; stoppedBy: "429" | "time" | null };

/** Profile timestamps survive instance recycling; new UTC windows cannot reuse yesterday's volume sample. */
export async function refreshProfile(
  pool: ActivePool,
  fetcher: typeof fetch,
  now: number,
  signal: AbortSignal,
  upstream: { gate?: ThrottleGate } = {},
): Promise<StoredProfile> {
  const config = getRwaConfig(),
    cached = pool.profile;
  const sameMints = (profile: VolumeProfile) =>
    profile.economics.mintA === pool.pair.mintA &&
    profile.economics.mintB === pool.pair.mintB;
  if (
    cached &&
    cached.algorithmVersion === ALGORITHM_VERSION &&
    sameMints(cached.profile) &&
    hasPriceHistory(cached.profile) &&
    !cached.profile.stale &&
    cached.windowEndUtc === volumeWindowEnd(now) &&
    now - Date.parse(cached.observedAt) < config.profileTtlMs
  )
    return cached;
  const fresh = await loadVolumeProfile(
    pool.pair.poolAddress,
    fetcher,
    Math.floor(now / 1000),
    { retry: { signal }, ...upstream },
  );
  if (!sameMints(fresh)) throw new Error("Pool profile mint identity mismatch");
  const timestamps = [
    fresh.observedAt?.economics,
    fresh.observedAt?.daily,
    fresh.observedAt?.hourly,
  ]
    .filter((x): x is string => !!x)
    .sort();
  if (hasPriceHistory(fresh))
    return {
      algorithmVersion: ALGORITHM_VERSION,
      profile: fresh,
      windowEndUtc: volumeWindowEnd(now),
      observedAt: timestamps[0] ?? new Date(now).toISOString(),
    };
  if (
    cached &&
    cached.algorithmVersion === ALGORITHM_VERSION &&
    sameMints(cached.profile) &&
    hasPriceHistory(cached.profile) &&
    now - Date.parse(cached.observedAt) < SAVED_PRICE_HISTORY_MAX_AGE_MS
  ) {
    return {
      ...cached,
      profile: {
        ...fresh,
        daily: fresh.daily ?? cached.profile.daily,
        candles: cached.profile.candles,
        stale: true,
        observedAt: {
          economics: fresh.observedAt?.economics ?? new Date(now).toISOString(),
          daily: fresh.daily
            ? (fresh.observedAt?.daily ?? null)
            : (cached.profile.observedAt?.daily ?? null),
          hourly: cached.profile.observedAt?.hourly ?? cached.observedAt,
        },
        issues: [...fresh.issues, "Using previously saved price history"],
      },
    };
  }
  return {
    algorithmVersion: ALGORITHM_VERSION,
    profile: fresh,
    windowEndUtc: volumeWindowEnd(now),
    observedAt: timestamps[0] ?? new Date(now).toISOString(),
  };
}

/** One job run (claim → work → finish). Exported for the local cron runner and tests. */
export async function runJob(job: JobName, options: Options): Promise<JobResult> {
  const store = options.store ?? getRwaStore(),
    config = getRwaConfig(),
    clock = options.clock ?? Date.now;
  const lease = await store.request({
    op: "claim",
    job,
    force: !!options.force,
  });
  if (!lease) return { job, status: "skipped", processed: 0, issues: [] };
  const startedAt = clock();
  // Each job has its own timeout, clamped so the invocation ends inside the route's maxDuration.
  const timeoutMs = Math.max(1_000, Math.min(job === "rwa-apr-refresh" ? config.aprJobTimeoutMs : config.jobTimeoutMs,
    (options.deadlineMs ?? Number.POSITIVE_INFINITY) - startedAt));
  const jobDeadline = startedAt + timeoutMs;
  const signal = AbortSignal.timeout(timeoutMs),
    issues: string[] = [];
  let processed = 0,
    status: "ok" | "partial" | "error" = "ok",
    rhcDiscovery: JobResult["rhcDiscovery"],
    rhcStats: RhcAprRunStats | undefined,
    queue: AprQueueStats | undefined;
  try {
    if (job === "rwa-discovery") {
      const result = await discoverRwaPairs({
        minTvl: 0,
        maxPages: config.maxPages,
        sortBy: "estimatedFeeApr",
        fetcher: options.fetcher,
        signal,
      });
      signal.throwIfAborted();
      if (!result.discovery)
        throw new Error("Discovery coverage metadata missing");
      const data: DiscoveryWrite = { result, ...result.discovery };
      await store.request({ op: "publishDiscovery", lease, data });
      processed = result.pairs.length;
      // Best effort: a missing table or an indexer outage leaves the snapshot published and the old icons in place.
      await refreshTokenIcons(store, lease, result.pairs, options.fetcher, signal).catch(() => {
        issues.push("Token icons not saved");
      });
      // Best effort, state reads only (one multicall): reported here and to Sentry, never published.
      rhcDiscovery = await discoverRhcRegistryPools(options.rhcClient ?? rhcStateClient())
        .then((result) => { captureRhcDiscoveryFindings(rhcDiscoveryFindings(result)); return result; })
        .catch((error) => ({ error: sanitizePublicError(error, "RHC discovery failed").slice(0, 200) }));
    } else {
      const result = await refreshAprPools({ store, lease, options, signal, clock, jobDeadline });
      processed = result.processed;
      issues.push(...result.issues);
      rhcStats = result.rhcStats;
      queue = result.queue;
      if (issues.length) status = "partial";
    }
  } catch (error) {
    status = "error";
    issues.push(sanitizePublicError(error, "Refresh failed").slice(0, 400));
  }
  try {
    await store.request({
      op: "finish",
      lease,
      processed,
      outcome: status,
      issues: issues.slice(0, 20),
    });
  } catch {
    status = "error";
    issues.push("Job lease was lost before completion");
  }
  return {
    job, status, processed, issues: issues.slice(0, 20), elapsedMs: clock() - startedAt,
    ...(rhcDiscovery ? { rhcDiscovery } : {}), ...(rhcStats ? { rhc: rhcStats } : {}), ...(queue ? { queue } : {}),
  };
}

export async function refreshRwaSnapshots(options: Options = {}) {
  const clock = options.clock ?? Date.now;
  const deadlineMs = options.deadlineMs ?? clock() + RWA_REFRESH_MAX_DURATION_MS - RWA_REFRESH_DEADLINE_SLACK_MS;
  // A complete newly published generation is available before APR enumerates its pools.
  const discovery = await runJob("rwa-discovery", { ...options, deadlineMs });
  const apr = await runJob("rwa-apr-refresh", { ...options, deadlineMs });
  return { discovery, apr };
}

type QueueItem =
  | { kind: "solana"; poolId: string; refreshedAt: string | null; pool: ActivePool }
  | { kind: "rhc"; poolId: string; refreshedAt: string | null; spec: RhcRun["pools"][number]["spec"] };

/**
 * The APR queue order: pools never refreshed first, then the oldest last refresh or attempt (`refreshedAt`), then
 * pool id (stable). Solana and RHC pools in one list.
 */
export function orderAprQueue<T extends { poolId: string; refreshedAt?: string | null }>(items: readonly T[]): T[] {
  const at = (item: T) => {
    const ms = item.refreshedAt ? Date.parse(item.refreshedAt) : Number.NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };
  return [...items].sort((a, b) => at(a) - at(b) || (a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0));
}

/**
 * The `rwa-apr-refresh` work: ONE queue of the Solana and RHC pools, oldest refresh first, the first
 * `APR_POOLS_PER_RUN` of it refreshed one pool at a time on one GeckoTerminal gate (never two calls in parallel).
 * A 429 ends the run: the pool that hit it is not saved and, with the pools not reached, goes first next run.
 * Each pool's daily history row is written by its first successful update of the Taipei day (`saveApr`).
 */
async function refreshAprPools(input: {
  store: RwaStore; lease: Lease; options: Options; signal: AbortSignal; clock: () => number; jobDeadline: number;
}): Promise<{ processed: number; issues: string[]; rhcStats?: RhcAprRunStats; queue: AprQueueStats }> {
  const { store, lease, options, signal, clock, jobDeadline } = input;
  const fetcher = options.fetcher ?? fetch;
  const gate = options.geckoGate ?? createCronGeckoGate();
  const throttled = () => gate.blockedForMs() > 0;
  const issues: string[] = [];
  // Finalizes earlier days' history rows and seeds today's (idempotent).
  await store.request({ op: "prepareDaily", lease });
  let rhc: RhcRun | null = null;
  if (isRhcApr7dEnabled()) {
    rhc = await prepareRhcRun({ store, lease, fetcher, clock, signal, gate }).catch((error) => {
      issues.push(`RHC: ${sanitizePublicError(error, "RHC APR refresh failed").slice(0, 200)}`);
      return null;
    });
  }
  const pools = await store.request({ op: "activePools" });
  const all = orderAprQueue<QueueItem>([
    ...pools.map((pool) => ({ kind: "solana" as const, poolId: pool.pair.poolAddress, refreshedAt: pool.refreshedAt ?? null, pool })),
    ...(rhc?.pools ?? []).map(({ spec, poolId, refreshedAt }) => ({ kind: "rhc" as const, poolId, refreshedAt, spec })),
  ]);
  const selected = all.slice(0, APR_POOLS_PER_RUN);
  const queue: AprQueueStats = { pools: all.length, selected: selected.length, done: 0, stoppedBy: null };
  let processed = 0;
  // The RHC pools/multi call already hit a 429: end the run before any pool.
  if (throttled()) queue.stoppedBy = "429";
  for (const item of queue.stoppedBy ? [] : selected) {
    if (jobDeadline - clock() < APR_POOL_BUDGET_MS + APR_SAVE_RESERVE_MS) { queue.stoppedBy = "time"; break; }
    signal.throwIfAborted();
    let outcome: PoolOutcome;
    if (item.kind === "solana") {
      const result = await refreshSolanaPool({ store, lease, pool: item.pool, fetcher, clock, signal, gate, throttled });
      outcome = result.outcome;
      if (result.issue) issues.push(result.issue);
    } else {
      const rhcOutcome = await rhc!.refreshPool(item.spec);
      outcome = rhcOutcome === "saved" ? "fresh" : rhcOutcome === "failed" ? "error" : rhcOutcome;
    }
    if (outcome === "throttled") { queue.stoppedBy = "429"; break; }
    queue.done += 1;
    if (outcome !== "error") processed += 1;
    if (throttled()) { queue.stoppedBy = "429"; break; }
  }
  if (queue.stoppedBy === "429") issues.push(`GeckoTerminal 429: run ended after ${queue.done} of ${queue.selected} pools; the rest go first next run`);
  if (queue.stoppedBy === "time") issues.push(`Time budget: run ended after ${queue.done} of ${queue.selected} pools; the rest go first next run`);
  let rhcStats: RhcAprRunStats | undefined;
  if (rhc) {
    issues.push(...rhc.issues);
    const done = new Set(selected.slice(0, queue.done).map((item) => item.poolId));
    rhcStats = { ...rhc.stats, deferred: rhc.pools.filter((pool) => !done.has(pool.poolId)).length };
  }
  return { processed, issues, rhcStats, queue };
}

/** One Solana pool: price history (gated) and liquidity, then one saved snapshot. Never throws. */
async function refreshSolanaPool(input: {
  store: RwaStore; lease: Lease; pool: ActivePool; fetcher: typeof fetch; clock: () => number; signal: AbortSignal;
  gate: ThrottleGate; throttled: () => boolean;
}): Promise<{ outcome: PoolOutcome; issue: string | null }> {
  const { store, lease, pool, clock, signal } = input;
  const poolId = pool.pair.poolAddress;
  try {
    signal.throwIfAborted();
    await store.request({ op: "renew", lease });
    const [profile, chainSnapshot] = await Promise.all([
      refreshProfile(pool, input.fetcher, clock(), signal, { gate: input.gate }),
      readOnchainPoolLiquidity(
        poolId,
        rpcConnection(undefined, { signal, retry: { budgetMs: 8000 } }),
      ).then((chain) => ({
        chain,
        observedAt: new Date(clock()).toISOString(),
      })),
    ]);
    // Its price-history fetch hit a 429: save nothing, so the pool keeps its place at the front of the queue.
    if (input.throttled())
      return { outcome: "throttled", issue: null };
    const chain = chainSnapshot.chain,
      chainObservedAt = chainSnapshot.observedAt;
    if (
      chain.mintA !== profile.profile.economics.mintA ||
      chain.mintB !== profile.profile.economics.mintB
    )
      throw new Error("On-chain pool mint identity mismatch");
    const payload = assemblePoolRangeApr(
      poolId,
      profile.profile,
      chain,
      Math.floor(clock() / 1000),
    );
    payload.sample.windowEndUtc = profile.windowEndUtc;
    payload.sample.windowStartUtc = new Date(
      Date.parse(profile.windowEndUtc) - payload.sample.days * 86_400_000,
    ).toISOString();
    signal.throwIfAborted();
    await store.request({
      op: "saveApr",
      lease,
      data: {
        poolId,
        payload,
        profile,
        chainObservedAt,
        issues: profile.profile.issues.slice(0, 20),
      },
    });
    if (payload.sample.degraded) return { outcome: "degraded", issue: `${poolId}: Price history unavailable` };
    if (payload.sample.priceHistoryStale) return { outcome: "stale", issue: `${poolId}: Using previously saved price history` };
    return { outcome: "fresh", issue: null };
  } catch (error) {
    const message = sanitizePublicError(
      error,
      "APR refresh failed",
    ).slice(0, 400);
    if (!signal.aborted)
      await store.request({
        op: "saveApr",
        lease,
        data: {
          poolId,
          payload: null,
          profile: null,
          chainObservedAt: null,
          issues: [message],
        },
      }).catch(() => undefined);
    return { outcome: "error", issue: `${poolId}: ${message}` };
  }
}

/**
 * Daily token icon pass, run inside the rwa-discovery job after the pool scan: Solana pool tokens (Jupiter → Raydium
 * → manual) and the allowlisted Robinhood Chain pool tokens (DexScreener → GeckoTerminal → manual). Only links that
 * pass `ICON_HOSTS` are written.
 */

export async function refreshTokenIcons(store: RwaStore, lease: Lease, pairs: readonly Pick<RwaPairRow, "mintA" | "mintB">[],
  fetcher: typeof fetch | undefined, signal: AbortSignal) {
  const solana = await resolveTokenIcons("solana", pairs.flatMap((pair) => [pair.mintA, pair.mintB]), solanaIconSources(fetcher), { signal });
  const rhc = await resolveTokenIcons("robinhood",
    UNIV4_RHC_ALLOWLISTED_POOLS.flatMap((pool) => [pool.currency0.address, pool.currency1.address]), rhcIconSources(fetcher), { signal });
  signal.throwIfAborted();
  await store.request({ op: "renew", lease });
  return store.request({ op: "saveTokenIcons", lease, data: [...solana, ...rhc] });
}
