import "server-only";
import { fetchMeteoraPoolDailyApr } from "@/lib/meteora-daily-apr";
import type { PoolDailyAprResult } from "@/lib/pool-daily-apr";
import { DexError } from "../errors";
import { listedMeteoraPool, type MeteoraPoolList } from "./pools.server";

/**
 * /api/pool-daily-apr for Meteora DLMM: only pools SoFinance lists (static allowlist, plus the RWA feed when the store
 * is on) get the Meteora series; anything else is null so the registry moves on.
 *
 * When the pool list cannot be read (store error) this throws UPSTREAM rather than returning null: null would mean "not
 * a Meteora pool", and a listed Meteora pool must never be answered with another DEX's series. The route still serves a
 * pool that Raydium knows (Raydium pools keep working while the store is down) and answers 5xx, uncached, otherwise.
 */
export async function meteoraPoolDailyApr(
  poolId: string,
  deps: { listedPool?: MeteoraPoolList; load?: typeof fetchMeteoraPoolDailyApr } = {},
): Promise<PoolDailyAprResult | null> {
  let listed;
  try {
    listed = await (deps.listedPool ?? listedMeteoraPool)(poolId);
  } catch {
    throw new DexError("UPSTREAM", "The Meteora pool list could not be read, so this pool's daily APR is unavailable right now. Please retry shortly.");
  }
  if (!listed) return null;
  try {
    return await (deps.load ?? fetchMeteoraPoolDailyApr)(poolId);
  } catch (error) {
    throw new DexError("UPSTREAM", error instanceof Error && error.message ? error.message : "Meteora did not answer for this pool.");
  }
}
