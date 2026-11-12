import "@/lib/engine-host";
import "server-only";
import { discoverMeteoraRwaPairs, METEORA_SCAN_MIN_TVL_USD, type MeteoraScanStats } from "../meteora-rwa-scan";
import { FEED_KEY, FEED_KEY_METEORA, SOLANA_FEED_PROTOCOL, type Lease, type RwaStore } from "../rwa-store-types";
import type { RwaPairRow } from "../rwa-pairs";
import { APR_SAVE_RESERVE_MS, activePoolRefreshedAt, orderAprQueue } from "./apr-queue";
import { refreshSolanaPool } from "./solana-pool";
import type { ThrottleGate } from "../range-apr/throttle-gate";

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

/** The Meteora lane's queue (datapi, not GeckoTerminal): its own oldest-first queue and stop reason. */
export type MeteoraAprQueueStats = { pools: number; selected: number; done: number; stoppedBy: "datapi-429" | "time" | null; failed: number };

/**
 * The Meteora DLMM scan, published as the `meteora-dlmm-rwa-v1` generation. Seeds include the Raydium feed's mints.
 * The summary carries the scan counts (bin steps above 10 left out, SCAN_DESIGN.md §12 Q5).
 * Time the Meteora scan may take inside discovery (~2 × seeds requests at 5 at a time, then one RPC batch), so a slow
 * datapi leaves time for the icons and the RHC check.
 */
const METEORA_SCAN_BUDGET_MS = 30_000;

export async function publishMeteoraFeed(store: RwaStore, lease: Lease, raydiumPairs: readonly RwaPairRow[],
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

export async function refreshMeteoraLane(input: {
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
