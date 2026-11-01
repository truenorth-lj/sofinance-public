import "server-only";
import { METEORA_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/meteora/constants";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { getRwaStore } from "@/lib/rwa-store";
import { FEED_KEY_METEORA } from "@/lib/rwa-store-types";

/**
 * Which Meteora DLMM pools SoFinance opens in (DESIGN.md §3 PR4: the allowlist is derived from the RWA feed, then the
 * adapter's own on-chain checks run on top). A pool is listed when it is
 *   - on the engine's static allowlist (`METEORA_ALLOWLISTED_POOLS`, the original cbBTC/WBTC pool), or
 *   - in the current generation of the Meteora RWA feed (`meteora-dlmm-rwa-v1`, written by the RWA scan) and not
 *     marked blocked by that scan.
 * The feed lives in the RWA store, so it is only read when the store is on (`SOFINANCE_RWA_DB_ENABLED`); without the
 * store only the static allowlist is listed. Being listed is necessary, never sufficient: the adapter still reads the
 * LbPair and both mints from chain before every open.
 */
export type ListedMeteoraPool = {
  poolId: string;
  /** The two pool mints as listed (order not guaranteed to match the LbPair's X / Y). */
  mints: readonly [string, string];
  /** Static allowlist entries pin the bin step; feed rows leave it to the chain. */
  binStep: number | null;
  source: "allowlist" | "rwa-feed";
};

export type MeteoraPoolList = (poolId: string) => Promise<ListedMeteoraPool | null>;

const FEED_TTL_MS = 60_000;
let feedCache: { at: number; pools: Map<string, ListedMeteoraPool> } | undefined;

async function feedPools(now: number): Promise<Map<string, ListedMeteoraPool>> {
  if (feedCache && now - feedCache.at < FEED_TTL_MS) return feedCache.pools;
  const rows = await getRwaStore().request({ op: "activePools", feedKeys: [FEED_KEY_METEORA] });
  const pools = new Map<string, ListedMeteoraPool>();
  for (const { pair } of rows) {
    if (pair.protocol !== "meteora-dlmm" || pair.blocked) continue;
    pools.set(pair.poolAddress, { poolId: pair.poolAddress, mints: [pair.mintA, pair.mintB], binStep: null, source: "rwa-feed" });
  }
  feedCache = { at: now, pools };
  return pools;
}

export function clearMeteoraPoolListCache() {
  feedCache = undefined;
}

export const listedMeteoraPool: MeteoraPoolList = async (poolId) => {
  const fixed = METEORA_ALLOWLISTED_POOLS.find((pool) => pool.poolAddress === poolId);
  if (fixed) return { poolId, mints: [fixed.mintX, fixed.mintY], binStep: fixed.binStep, source: "allowlist" };
  if (!getRwaConfig().enabled) return null;
  return (await feedPools(Date.now())).get(poolId) ?? null;
};
