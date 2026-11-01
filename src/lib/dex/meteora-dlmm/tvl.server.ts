import "server-only";
import { getRwaConfig } from "@/lib/config/rwa-env";
import { getRwaStore } from "@/lib/rwa-store";

/**
 * A Meteora pool's stored daily TVL (`rwa_meteora_tvl_daily`, written once per UTC day by the APR refresh) as UTC day →
 * USD. Without the store (`SOFINANCE_RWA_DB_ENABLED` off) there is none; a store error throws, and the daily APR then
 * uses today's TVL for every day and says why.
 */
export async function storedMeteoraTvl(poolId: string, from: string, to: string): Promise<ReadonlyMap<string, number>> {
  if (!getRwaConfig().enabled) return new Map();
  const { points } = await getRwaStore().request({ op: "meteoraTvlHistory", poolId, from, to });
  return new Map(points.map((point) => [point.date, point.tvlUsd]));
}
