import "@/lib/engine-host";
import "server-only";
import { sanitizePublicError } from "../public-error";
import { createCronGeckoGate } from "../pool-metrics/gecko";
import { isRhcApr7dEnabled } from "../protocol-flags";
import { dexRegistry, type DailyTvlStats, type DexId } from "@/lib/dex";
import { FEED_KEY, FEED_KEY_METEORA, type ActivePool, type Lease, type RwaStore } from "../rwa-store-types";
import type { Options } from "./job";
import { type PoolOutcome, refreshSolanaPool } from "./solana-pool";
import { METEORA_APR_POOL_TIMEOUT_MS, refreshMeteoraLane, type MeteoraAprQueueStats } from "./meteora-lane";
import { prepareRhcAprLane, type RhcAprRunStats, type RhcRun } from "./rhc-lane";

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

export type AprQueueStats = { pools: number; selected: number; done: number; stoppedBy: "429" | "time" | null };


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
export async function refreshAprPools(input: {
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
  // A 429 or an error anywhere in the run (not a time-budget stop, not a degraded / stale estimate).
  let failed = false;
  const prepared = await prepareRhcAprLane({ store, lease, fetcher, clock, signal, gate });
  const rhc = prepared.rhc;
  issues.push(...prepared.issues);
  if (prepared.failed) failed = true;
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
