import "server-only";
import { fetchMeteoraPoolDailyApr } from "@/lib/meteora-daily-apr";
import type { PoolDailyAprResult } from "@/lib/pool-daily-apr";
import { listedMeteoraPool, type MeteoraPoolList } from "./pools.server";

/**
 * /api/pool-daily-apr for Meteora DLMM: only pools SoFinance lists (static allowlist, plus the RWA feed when the store
 * is on) get the Meteora series; anything else is null so the registry moves on. When the pool list itself cannot be
 * read (store error) the pool is treated as not Meteora's, so Raydium pools keep working while the store is down.
 */
export async function meteoraPoolDailyApr(
  poolId: string,
  deps: { listedPool?: MeteoraPoolList; load?: typeof fetchMeteoraPoolDailyApr } = {},
): Promise<PoolDailyAprResult | null> {
  let listed;
  try {
    listed = await (deps.listedPool ?? listedMeteoraPool)(poolId);
  } catch {
    return null;
  }
  if (!listed) return null;
  return (deps.load ?? fetchMeteoraPoolDailyApr)(poolId);
}
