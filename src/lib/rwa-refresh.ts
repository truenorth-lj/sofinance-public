import "@/lib/engine-host";
import "server-only";
import type { PublicClient } from "viem";
import { getRwaConfig } from "./config/rwa-env";
import {
  assemblePoolRangeApr,
  hasPriceHistory,
  type VolumeProfile,
} from "./pool-range-apr";
import { poolSourceFor } from "./pool-sources/registry";
import { raydiumPoolSource } from "./pool-sources/raydium";
import type { PoolSource } from "./pool-sources/types";
import type { ThrottleGate } from "./range-apr/throttle-gate";
import { createCronGeckoGate } from "./pool-metrics/gecko";
import { SAVED_PRICE_HISTORY_MAX_AGE_MS } from "./rwa-freshness";
import { rpcConnection } from "@sofinance/engine/rpc";
import { volumeWindowEnd } from "./rwa-daily";
import { sanitizePublicError } from "./public-error";
import { getRwaStore } from "./rwa-store";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { isRhcApr7dEnabled } from "./protocol-flags";
import { discoverMeteoraRwaPairs, METEORA_SCAN_MIN_TVL_USD, type MeteoraScanStats } from "./meteora-rwa-scan";
import { prepareRhcRun, type RhcAprRunStats, type RhcRun } from "./rhc-apr-refresh";
import { discoverRhcRegistryPools, rhcDiscoveryFindings, type RhcDiscoveryResult } from "./pool-metrics/rhc-discovery";
import { rhcStateClient } from "./rhc-range-apr";
import { dexRegistry, type DailyTvlStats, type DexId } from "@/lib/dex";
import { captureRhcDiscoveryFindings } from "./sentry/capture";
import { resolveTokenIcons, rhcCronIconSources } from "./token-icons/resolve";
import type { RwaPairRow } from "./rwa-pairs";
import {
  ALGORITHM_VERSION,
  FEED_KEY,
  FEED_KEY_METEORA,
  SOLANA_FEED_PROTOCOL,
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
  /** Meteora scan: test override (default on). */
  meteoraScan?: boolean;
  /** Per-pool limit of the Meteora APR lane (tests); default `METEORA_APR_POOL_TIMEOUT_MS`. */
  meteoraPoolTimeoutMs?: number;
};

/**
 * Vercel `maxDuration` of `/api/internal/rwa-refresh` (the route exports the same literal; tested). Discovery and
 * the APR job together must finish inside it, so the APR job's budget is clamped to what is left of it.
 */
export const RWA_REFRESH_MAX_DURATION_MS = 300_000;
/** 20% of `maxDuration` kept free: the whole invocation (discovery + APR) is budgeted to 240 s. */
const RWA_REFRESH_DEADLINE_SLACK_MS = 60_000;
/** No pool is started inside this last part of the APR job: `prepareDaily`, `finish` and the response. */
export const APR_SAVE_RESERVE_MS = 10_000;
/**
 * Longest time one pool can take (the run's start guard), all in parallel then the save: Raydium economics (3
 * attempts × 5 s timeout + backoff ≈ 17 s); 2 gated GeckoTerminal calls (one attempt each, the first waits ≤ 12 s for
 * its slot after the previous pool's last call, the second 12 s after the first, 5 s timeout: ≤ 29 s); the RPC
 * liquidity read (10 s cap); plus renew + save ≈ 32 s. A pool is started only when this plus `APR_SAVE_RESERVE_MS` is
 * left, so the job timeout does not cut one in normal runs (if it still does, the run stops cleanly with `stoppedBy:
 * "time"`).
 */
export const APR_POOL_MAX_MS = 32_000;
/** Fixed APR-job time before the queue, measured 10/31: RHC pools/multi + state multicalls + roster ≈ 10 s. */
export const APR_QUEUE_FIXED_MS = 15_000;
/**
 * Most pools started per cron run (Solana + RHC, one oldest-first queue, one GeckoTerminal call at a time). The
 * time guard (`APR_POOL_MAX_MS`), not this cap, is what normally ends a run.
 * Time: the APR job gets its 180 s timeout (discovery took 47 s on 11/1, so the 240 s invocation budget leaves 193 s).
 * At 12 s per GeckoTerminal call that is ~13 calls: 1 pools/multi + ~12 candle calls, i.e. ~6 Solana pools (2 calls)
 * or ~11 RHC pools (1 call) per run. Measured 11/1 00:15 Taipei: only 3 pools fit before the 429 at 2.5 s spacing.
 * N = 12 is the 1-call case rounded up, so the cap never cuts a run the time guard would let finish.
 * Coverage: 29 active pools (18 Solana × 2 calls + 11 RHC × 1 call = 47 calls), 6 runs/day (every 4 h), ~12 calls per
 * run: every pool is refreshed about every 4 runs = 16 h, within 24 h with one run in a row lost to a 429 (tested),
 * so inside the 26 h `APR_SNAPSHOT_MAX_AGE_MS` limit. Pools past 26 h show "Data delayed" with the saved estimate (up to
 * 48 h of saved history); nothing is cleared.
 * Rate: ≤ 5 calls/min, the documented keyless limit (was 2.5 s / ≤ 24 per min, which hit 429 after 8 calls).
 */
export const APR_POOLS_PER_RUN = 12;

/**
 * A pool whose price history is unavailable (degraded: no estimate saved) is a pool-level problem: its snapshot says so
 * and the run is "partial", but the job only counts as failed when MORE than this share of the pools it finished
 * were degraded (e.g. 1 of 7 is not a failure, 4 of 7 is). Errors, 429s and exceptions still fail the job on their own.
 */
const APR_DEGRADED_FAILURE_SHARE = 0.5;
/** True when the degraded pools are more than `APR_DEGRADED_FAILURE_SHARE` of the pools finished this run. */
export function degradedIsSystemic(degraded: number, done: number): boolean {
  return done > 0 && degraded > done * APR_DEGRADED_FAILURE_SHARE;
}

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
  /** rwa-apr-refresh: the Meteora lane. */
  meteoraQueue?: MeteoraAprQueueStats;
  /** rwa-apr-refresh: each DEX's daily TVL record, by DEX id (registry `recordDailyTvl`). */
  dailyTvl?: Partial<Record<DexId, DailyTvlStats>>;
  /** rwa-discovery: the Meteora DLMM scan. */
  meteora?: (MeteoraScanStats & { published: number }) | { error: string };
};
export type AprQueueStats = { pools: number; selected: number; done: number; stoppedBy: "429" | "time" | null };
/** The Meteora lane's queue (datapi, not GeckoTerminal): its own oldest-first queue and stop reason. */
export type MeteoraAprQueueStats = Omit<AprQueueStats, "stoppedBy"> & { stoppedBy: "datapi-429" | "time" | null; failed: number };

/**
 * Meteora DLMM lane of the APR job: pools of the `meteora-dlmm-rwa-v1` feed with TVL ≥
 * $5k, oldest first, `METEORA_APR_POOLS_PER_RUN` per run, `METEORA_APR_CONCURRENCY` at a time, each within
 * `METEORA_APR_POOL_TIMEOUT_MS`. Price history comes from Meteora's datapi (no GeckoTerminal call), so the lane runs
 * beside the GeckoTerminal queue on the same job deadline. A datapi 429 ends the lane (that pool saves nothing).
 * Datapi cost per pool: 1 pool + 1 daily volume + 3 hourly OHLCV spans = 5 requests (8 pools ≈ 40 per run).
 */
export const METEORA_APR_POOLS_PER_RUN = 8;
const METEORA_APR_CONCURRENCY = 3;
export const METEORA_APR_POOL_TIMEOUT_MS = 10_000;

/**
 * Profile timestamps survive instance recycling; new UTC windows cannot reuse yesterday's volume sample. The pool's
 * `PoolSource` (by its stored protocol) loads a fresh profile.
 */
export async function refreshProfile(
  pool: ActivePool,
  fetcher: typeof fetch,
  now: number,
  signal: AbortSignal,
  upstream: { gate?: ThrottleGate } = {},
  source: PoolSource = poolSourceFor(pool.pair.protocol),
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
  const fresh = await source.loadProfile(
    pool.pair.poolAddress,
    fetcher,
    Math.floor(now / 1000),
    // The stored row too: a source that reads the pool by its own spec (Meteora's bin step) needs it.
    { retry: { signal }, ...upstream, pair: pool.pair },
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
    meteora: JobResult["meteora"],
    rhcStats: RhcAprRunStats | undefined,
    queue: AprQueueStats | undefined,
    meteoraQueue: MeteoraAprQueueStats | undefined,
    dailyTvl: Partial<Record<DexId, DailyTvlStats>> | undefined,
    // Counted in `consecutive_failures` (and keeps `last_success_at`). The APR job counts only a GeckoTerminal 429 or
    // an error (a failed step, a pool error, or more than half of the finished pools degraded); a run that only ran out of its time budget, or saved
    // stale estimates from saved price history, is not a failure.
    failure = false;
  try {
    if (job === "rwa-discovery") {
      // Raydium first (the feed the site lists today), then Meteora into its own feed (SCAN_DESIGN.md §3).
      const result = await raydiumPoolSource.discover({
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
      // Meteora DLMM (code flag): its own feed and generation, after Raydium's publish, so a Meteora failure keeps
      // its last generation and never touches Raydium's. Reported as an issue, not counted as a job failure.
      if (options.meteoraScan ?? true) {
        meteora = await publishMeteoraFeed(store, lease, result.pairs, options.fetcher, signal)
          .catch((error) => ({ error: sanitizePublicError(error, "Meteora scan failed").slice(0, 200) }));
        if ("error" in meteora) { issues.push(`Meteora: ${meteora.error}`); status = "partial"; }
      }
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
      meteoraQueue = result.meteoraQueue;
      dailyTvl = result.dailyTvl;
      failure = result.failed;
      if (issues.length) status = "partial";
    }
    // Discovery fails only when the Raydium scan or publish threw (the catch below); a Meteora issue leaves it "partial".
  } catch (error) {
    status = "error";
    failure = true;
    issues.push(sanitizePublicError(error, "Refresh failed").slice(0, 400));
  }
  try {
    await store.request({
      op: "finish",
      lease,
      processed,
      outcome: status,
      failure,
      issues: issues.slice(0, 20),
    });
  } catch {
    status = "error";
    issues.push("Job lease was lost before completion");
  }
  return {
    job, status, processed, issues: issues.slice(0, 20), elapsedMs: clock() - startedAt,
    ...(rhcDiscovery ? { rhcDiscovery } : {}), ...(meteora ? { meteora } : {}), ...(rhcStats ? { rhc: rhcStats } : {}), ...(queue ? { queue } : {}), ...(meteoraQueue ? { meteoraQueue } : {}),
    ...(dailyTvl ? { dailyTvl } : {}),
  };
}

/**
 * The Meteora DLMM scan, published as the `meteora-dlmm-rwa-v1` generation. Seeds include the Raydium feed's mints.
 * The summary carries the scan counts (bin steps above 10 left out, SCAN_DESIGN.md §12 Q5).
 */
/** Time the Meteora scan may take inside discovery (~2 × seeds requests at 5 at a time, then one RPC batch), so a slow
 * datapi leaves time for the icons and the RHC check. */
const METEORA_SCAN_BUDGET_MS = 30_000;

async function publishMeteoraFeed(store: RwaStore, lease: Lease, raydiumPairs: readonly RwaPairRow[],
  fetcher: typeof fetch | undefined, signal: AbortSignal): Promise<MeteoraScanStats & { published: number }> {
  const result = await discoverMeteoraRwaPairs({
    minTvl: METEORA_SCAN_MIN_TVL_USD, sortBy: "estimatedFeeApr", fetcher, signal: AbortSignal.any([signal, AbortSignal.timeout(METEORA_SCAN_BUDGET_MS)]),
    seedMints: raydiumPairs.flatMap((pair) => [pair.mintA, pair.mintB]),
  });
  signal.throwIfAborted();
  const { meteora, discovery, ...rest } = result;
  if (!discovery) throw new Error("Discovery coverage metadata missing");
  await store.request({ op: "publishDiscovery", lease, data: { feedKey: FEED_KEY_METEORA, result: { ...rest, scanStats: meteora }, ...discovery } });
  return { ...meteora, published: result.pairs.length };
}

export async function refreshRwaSnapshots(options: Options = {}) {
  const clock = options.clock ?? Date.now;
  const deadlineMs = options.deadlineMs ?? clock() + RWA_REFRESH_MAX_DURATION_MS - RWA_REFRESH_DEADLINE_SLACK_MS;
  // One GeckoTerminal gate for the whole invocation: the discovery job's icon pass and the APR queue share its
  // spacing, and a 429 in either ends the GeckoTerminal work of the run.
  const geckoGate = options.geckoGate ?? createCronGeckoGate();
  // A complete newly published generation is available before APR enumerates its pools.
  const discovery = await runJob("rwa-discovery", { ...options, deadlineMs, geckoGate });
  const apr = await runJob("rwa-apr-refresh", { ...options, deadlineMs, geckoGate });
  return { discovery, apr };
}

type QueueItem =
  | { kind: "solana"; poolId: string; refreshedAt: string | null; pool: ActivePool }
  | { kind: "rhc"; poolId: string; refreshedAt: string | null; spec: RhcRun["pools"][number]["spec"] };

/**
 * Queue key of a Solana pool: the store's `refreshedAt`, else (an older store / gateway that does not send it)
 * the saved profile's last fetch attempt or observation, so the queue never falls back to pool id order alone.
 */
export function activePoolRefreshedAt(pool: Pick<ActivePool, "refreshedAt" | "profile">): string | null {
  return pool.refreshedAt ?? pool.profile?.fetchState?.lastAttemptAt ?? pool.profile?.observedAt ?? null;
}

/**
 * The APR queue order: pools never refreshed first, then the oldest last refresh or attempt (`refreshedAt`), then
 * pool id (stable). Solana and RHC pools in one list.
 * `refreshedAt` is `GREATEST(payload_snapshot_at, last_attempt_at)` from the store (`refreshedAtSql`), so in practice
 * it is the pool's last attempt: every save (ok, degraded or error) sets `last_attempt_at`, and a snapshot is never
 * newer than the attempt that wrote it. A pool cut by a 429 or the time budget saves nothing, keeps its old key and
 * goes first next run; a failing pool still rotates to the back instead of blocking the queue.
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
}): Promise<{ processed: number; issues: string[]; rhcStats?: RhcAprRunStats; queue: AprQueueStats; failed: boolean;
  meteoraQueue?: MeteoraAprQueueStats; dailyTvl?: Partial<Record<DexId, DailyTvlStats>> }> {
  const { store, lease, options, signal, clock, jobDeadline } = input;
  const fetcher = options.fetcher ?? fetch;
  const gate = options.geckoGate ?? createCronGeckoGate();
  // Sticky: once any call of this run saw a 429 the run is over, even after the gate's cooldown has passed.
  const throttled = () => gate.hit429;
  const issues: string[] = [];
  // Finalizes earlier days' history rows and seeds today's (idempotent).
  const meteoraOn = options.meteoraScan ?? true;
  await store.request({ op: "prepareDaily", lease, includeRhc: isRhcApr7dEnabled(),
    ...(meteoraOn ? { feedKeys: [FEED_KEY, FEED_KEY_METEORA] } : {}) });
  let rhc: RhcRun | null = null;
  // A 429 or an error anywhere in the run (not a time-budget stop, not a degraded / stale estimate).
  let failed = false;
  if (isRhcApr7dEnabled()) {
    rhc = await prepareRhcRun({ store, lease, fetcher, clock, signal, gate }).catch((error) => {
      issues.push(`RHC: ${sanitizePublicError(error, "RHC APR refresh failed").slice(0, 200)}`);
      failed = true;
      return null;
    });
    // After prepare, the RHC issues are only the market batch's HTTP errors / 429 cooldown.
    if (rhc?.issues.length) failed = true;
  }
  // Renewed here and before every pool, so the lease (120 s) only has to outlive one pool or the prepare phase,
  // never the whole APR job timeout (`aprJobTimeoutMs`, up to 240 s).
  await store.request({ op: "renew", lease });
  const pools = await store.request({ op: "activePools" });
  const all = orderAprQueue<QueueItem>([
    ...pools.map((pool) => ({ kind: "solana" as const, poolId: pool.pair.poolAddress, refreshedAt: activePoolRefreshedAt(pool), pool })),
    ...(rhc?.pools ?? []).map(({ spec, poolId, refreshedAt }) => ({ kind: "rhc" as const, poolId, refreshedAt, spec })),
  ]);
  const selected = all.slice(0, APR_POOLS_PER_RUN);
  const queue: AprQueueStats = { pools: all.length, selected: selected.length, done: 0, stoppedBy: null };
  let processed = 0, degraded = 0;
  // Started before the GeckoTerminal queue and awaited after it: the two lanes share only the job deadline. The Meteora
  // lane first runs the registry's daily TVL record (Meteora: datapi, first run of the UTC day; later runs only fill gaps),
  // then refreshes.
  let dailyTvl: Partial<Record<DexId, DailyTvlStats>> | undefined;
  const meteoraLane = meteoraOn
    ? dexRegistry.recordDailyTvl({ store, lease, fetcher, clock, signal })
      .then((result) => {
        if (Object.keys(result.stats).length) dailyTvl = result.stats;
        issues.push(...result.issues, ...result.failures.map(({ displayName, error }) =>
          `${displayName} TVL: ${sanitizePublicError(error, "daily TVL not saved").slice(0, 200)}`));
      })
      .then(() => refreshMeteoraLane({ store, lease, fetcher, clock, signal, gate, jobDeadline,
        poolTimeoutMs: options.meteoraPoolTimeoutMs ?? METEORA_APR_POOL_TIMEOUT_MS }))
      .catch((error) => {
        issues.push(`Meteora: ${sanitizePublicError(error, "Meteora APR lane failed").slice(0, 200)}`);
        return undefined;
      })
    : undefined;
  // The RHC pools/multi call already hit a 429: end the run before any pool.
  if (throttled()) queue.stoppedBy = "429";
  for (const item of queue.stoppedBy ? [] : selected) {
    // Start a pool only if even its slowest case (`APR_POOL_MAX_MS`) plus the save reserve still fits.
    if (signal.aborted || jobDeadline - clock() < APR_POOL_MAX_MS + APR_SAVE_RESERVE_MS) { queue.stoppedBy = "time"; break; }
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
    // The job timeout fired mid-pool: that pool saved nothing (aborted); stop cleanly, it goes first next run.
    if (signal.aborted) { queue.stoppedBy = "time"; break; }
    queue.done += 1;
    if (outcome !== "error") processed += 1;
    // A pool error is a failure. A degraded pool (price history unavailable, no estimate) only counts when most are
    // (`degradedIsSystemic`, after the loop). A stale estimate from saved history is neither.
    if (outcome === "error") failed = true;
    if (outcome === "degraded") degraded += 1;
    if (throttled()) { queue.stoppedBy = "429"; break; }
  }
  if (queue.stoppedBy === "429") issues.push(`GeckoTerminal 429: run ended after ${queue.done} of ${queue.selected} pools; the rest go first next run`);
  // A time-budget stop is the normal end of a run (the guard, not APR_POOLS_PER_RUN, ends it): no issue, status stays
  // "ok"; it stays visible in `queue` (done / selected / stoppedBy "time"). The rest go first next run.
  let rhcStats: RhcAprRunStats | undefined;
  if (rhc) {
    issues.push(...rhc.issues);
    const done = new Set(selected.slice(0, queue.done).map((item) => item.poolId));
    rhcStats = { ...rhc.stats, deferred: rhc.pools.filter((pool) => !done.has(pool.poolId)).length };
  }
  if (queue.stoppedBy === "429" || throttled()) failed = true;
  if (degradedIsSystemic(degraded, queue.done)) failed = true;
  // Meteora lane outcomes are issues (the run is "partial"), not failures of the job (like its discovery).
  const meteora = await meteoraLane;
  if (meteora) {
    processed += meteora.processed;
    issues.push(...meteora.issues);
  }
  return { processed, issues, rhcStats, queue, failed, ...(meteora ? { meteoraQueue: meteora.stats } : {}), ...(dailyTvl ? { dailyTvl } : {}) };
}

async function refreshMeteoraLane(input: {
  store: RwaStore; lease: Lease; fetcher: typeof fetch; clock: () => number; signal: AbortSignal; gate: ThrottleGate; jobDeadline: number;
  poolTimeoutMs: number;
}): Promise<{ processed: number; issues: string[]; stats: MeteoraAprQueueStats }> {
  const { store, clock, signal, jobDeadline } = input;
  // Feed lists are Raydium-first (store contract), so read both Solana feeds and keep the Meteora rows.
  const pools = (await store.request({ op: "activePools", feedKeys: [FEED_KEY, FEED_KEY_METEORA] }))
    .filter((pool) => pool.pair.protocol === SOLANA_FEED_PROTOCOL[FEED_KEY_METEORA] && (pool.pair.tvlUsd ?? 0) >= METEORA_SCAN_MIN_TVL_USD);
  const selected = orderAprQueue(pools.map((pool) => ({ poolId: pool.pair.poolAddress, refreshedAt: activePoolRefreshedAt(pool), pool })))
    .slice(0, METEORA_APR_POOLS_PER_RUN);
  const stats: MeteoraAprQueueStats = { pools: pools.length, selected: selected.length, done: 0, stoppedBy: null, failed: 0 };
  const issues: string[] = [];
  let processed = 0, next = 0;
  const worker = async () => {
    while (!stats.stoppedBy && next < selected.length) {
      // Start a pool only if its whole time limit plus the save reserve still fits.
      if (signal.aborted || jobDeadline - clock() < METEORA_APR_POOL_TIMEOUT_MS + APR_SAVE_RESERVE_MS) { stats.stoppedBy = "time"; break; }
      const item = selected[next++]!;
      const result = await refreshSolanaPool({ store, lease: input.lease, pool: item.pool, fetcher: input.fetcher, clock, signal,
        gate: input.gate, throttled: () => false, poolTimeoutMs: input.poolTimeoutMs });
      if (result.outcome === "throttled") { stats.stoppedBy = "datapi-429"; break; }
      if (signal.aborted) { stats.stoppedBy = "time"; break; }
      stats.done += 1;
      if (result.outcome !== "error") processed += 1;
      if (result.outcome === "error" || result.outcome === "degraded") stats.failed += 1;
      if (result.issue) issues.push(`Meteora ${result.issue}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(METEORA_APR_CONCURRENCY, selected.length) }, worker));
  if (stats.stoppedBy === "datapi-429") issues.push(`Meteora datapi 429: lane ended after ${stats.done} of ${stats.selected} pools; the rest go first next run`);
  // A time-budget stop is expected here too: visible in `meteoraQueue` stats only, not an issue.
  return { processed, issues, stats };
}

/** One Solana pool, through its `PoolSource`: price history (gated) and liquidity, then one saved snapshot. Never throws. */
async function refreshSolanaPool(input: {
  store: RwaStore; lease: Lease; pool: ActivePool; fetcher: typeof fetch; clock: () => number; signal: AbortSignal;
  gate: ThrottleGate; throttled: () => boolean;
  /** Per-pool time limit (the Meteora lane); a pool that hits it saves an error and rotates to the back. */
  poolTimeoutMs?: number;
}): Promise<{ outcome: PoolOutcome; issue: string | null }> {
  const { store, lease, pool, clock, signal } = input;
  const poolId = pool.pair.poolAddress;
  const source = poolSourceFor(pool.pair.protocol);
  // The job signal, or the job signal plus the per-pool limit (same object when there is no limit).
  const poolSignal = input.poolTimeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(input.poolTimeoutMs)]) : signal;
  // Saved under its own protocol (rows without one are Raydium CLMM, as before).
  const protocol = source === raydiumPoolSource ? {} : { protocol: source.id };
  try {
    poolSignal.throwIfAborted();
    await store.request({ op: "renew", lease });
    const [profile, chainSnapshot] = await Promise.all([
      refreshProfile(pool, input.fetcher, clock(), poolSignal, { gate: input.gate }, source),
      source.readLiquidity(
        poolId,
        rpcConnection(undefined, { signal: poolSignal, retry: { budgetMs: 8000 } }),
        pool.pair,
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
    // A source with its own assembly (Meteora) derives its presets there; the shared assembly takes them here.
    const presets = source.assemble ? undefined : source.presets?.(chain);
    const payload = source.assemble
      ? source.assemble(poolId, profile.profile, chain, Math.floor(clock() / 1000))
      : assemblePoolRangeApr(
        poolId,
        profile.profile,
        chain,
        Math.floor(clock() / 1000),
        presets ? { presets } : {},
      );
    payload.sample.windowEndUtc = profile.windowEndUtc;
    payload.sample.windowStartUtc = new Date(
      Date.parse(profile.windowEndUtc) - payload.sample.days * 86_400_000,
    ).toISOString();
    poolSignal.throwIfAborted();
    await store.request({
      op: "saveApr",
      lease,
      data: {
        poolId,
        ...protocol,
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
    // The source's own rate limit (Meteora datapi 429): save nothing, the pool keeps its place, its lane stops.
    if (source.isThrottleError?.(error)) return { outcome: "throttled", issue: null };
    const timedOut = poolSignal !== signal && poolSignal.aborted && !signal.aborted;
    const message = timedOut
      ? `Pool refresh timed out after ${Math.round(input.poolTimeoutMs! / 1000)} s`
      : sanitizePublicError(
        error,
        "APR refresh failed",
      ).slice(0, 400);
    if (!signal.aborted)
      await store.request({
        op: "saveApr",
        lease,
        data: {
          poolId,
          ...protocol,
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
 * Token icon pass, run inside the rwa-discovery job after the pool scan: Solana pool tokens (Jupiter → Raydium →
 * manual) and the allowlisted Robinhood Chain pool tokens (DexScreener only: no GeckoTerminal call in the cron, and
 * no manual rows, so a token DexScreener does not list keeps its saved icon; reads still fall back to the manual
 * list). Writes are upserts of the found rows only; nothing is deleted. Only links that pass `ICON_HOSTS` are written.
 */

export async function refreshTokenIcons(store: RwaStore, lease: Lease, pairs: readonly Pick<RwaPairRow, "mintA" | "mintB">[],
  fetcher: typeof fetch | undefined, signal: AbortSignal) {
  const solana = await resolveTokenIcons("solana", pairs.flatMap((pair) => [pair.mintA, pair.mintB]), raydiumPoolSource.iconSources(fetcher), { signal });
  const rhc = await resolveTokenIcons("robinhood",
    UNIV4_RHC_ALLOWLISTED_POOLS.flatMap((pool) => [pool.currency0.address, pool.currency1.address]), rhcCronIconSources(fetcher), { signal, manual: [] });
  signal.throwIfAborted();
  await store.request({ op: "renew", lease });
  return store.request({ op: "saveTokenIcons", lease, data: [...solana, ...rhc] });
}
