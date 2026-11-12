import "@/lib/engine-host";
import "server-only";
import type { PublicClient } from "viem";
import { getRwaConfig } from "../config/rwa-env";
import type { ThrottleGate } from "../range-apr/throttle-gate";
import { createCronGeckoGate } from "../pool-metrics/gecko";
import { sanitizePublicError } from "../public-error";
import { getRwaStore } from "../rwa-store";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { raydiumPoolSource } from "../pool-sources/raydium";
import type { MeteoraScanStats } from "../meteora-rwa-scan";
import { rhcStateClient } from "../rhc-range-apr";
import type { DailyTvlStats, DexId } from "@/lib/dex";
import { resolveTokenIcons, rhcCronIconSources } from "../token-icons/resolve";
import type { RwaPairRow } from "../rwa-pairs";
import {
  type DiscoveryWrite,
  type JobName,
  type Lease,
  type RwaStore,
} from "../rwa-store-types";
import type { AprQueueStats } from "./apr-queue";
import { refreshAprPools } from "./apr-queue";
import type { MeteoraAprQueueStats } from "./meteora-lane";
import { publishMeteoraFeed } from "./meteora-lane";
import type { RhcAprRunStats, RhcDiscoveryResult } from "./rhc-lane";
import { discoverRhcLane } from "./rhc-lane";

export type Options = {
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

export type JobResult = {
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
      rhcDiscovery = await discoverRhcLane(options.rhcClient ?? rhcStateClient());
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

