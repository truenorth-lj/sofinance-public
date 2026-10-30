import "server-only";
import { getRwaConfig } from "./config/rwa-env";
import { getRwaStore } from "./rwa-store";
import { fetchRhcRangeApr } from "./rhc-range-apr";
import { discoverRhcUniv4Pools, rhcPoolsResult, type RhcUniv4PoolsResult } from "./rhc-univ4-pools";

/*
 * Robinhood Chain reads for the page. With the RWA store on (production) these only return what the cron saved
 * (`rwa_pool_latest` feed `uniswap-v4-rhc-v1`, `rwa_apr_latest`), like Raydium's `/api/pool-range-apr`, so no
 * visitor request reaches GeckoTerminal, DexScreener or Robinhood Chain RPC. The live reads remain only as the
 * local-dev fallback when no store is configured. Kept apart from `rwa-store.ts` so Raydium never imports RHC code.
 */

/**
 * Robinhood Chain 7d APR for one allowlisted pool. With the RWA store on (production) it is only ever the cron's
 * saved snapshot; the live read is a local-dev fallback when no store is configured.
 */
export async function getRhcAprSnapshot(poolId: string) {
  const id = poolId.toLowerCase();
  if (!getRwaConfig().enabled) return fetchRhcRangeApr(id);
  return getRwaStore().request({ op: "apr", poolId: id });
}

/** Saved RHC pool summaries (TVL, 24h volume, hook fee, checks) from the cron; live read only without a store. */
export async function getRhcPoolsSnapshot(): Promise<RhcUniv4PoolsResult> {
  if (!getRwaConfig().enabled) return discoverRhcUniv4Pools();
  const snapshot = await getRwaStore().request({ op: "rhcPools" });
  return rhcPoolsResult(snapshot.pools, snapshot.observedAt ?? new Date(0).toISOString(), { stale: snapshot.stale, snapshot: true });
}

