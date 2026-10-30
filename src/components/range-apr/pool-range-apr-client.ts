import { AsyncCache } from "@/lib/async-cache";
import { createConcurrencyLimit } from "@/lib/concurrency-limit";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";

/**
 * Browser fetcher for `/api/pool-range-apr`. Every consumer (pair cards and the Create position
 * modal) goes through here, so a pool is requested once per minute no matter how many components ask, and
 * the page never opens more than two requests at a time.
 */
const limit = createConcurrencyLimit(2);
let cacheEpoch = 0;
/** A degraded payload (no estimates) is kept only briefly so the next ask hits the server again. */
const DEGRADED_TTL_MS = 8_000;
const cache = new AsyncCache<PoolRangeAprPayload>({
  ttlMs: 60_000, failureTtlMs: 10_000, ttlFor: (payload) => (payload.sample.degraded ? DEGRADED_TTL_MS : 60_000),
});

/** Raydium pools use `/api/pool-range-apr`; Orca / Meteora use the flag-gated `/api/protocol-pools/range-apr` (same payload shape). */
export type RangeAprProtocol = "raydium-clmm" | "orca-whirlpool" | "meteora-dlmm" | "uniswap-v4-rhc";

const rangeAprUrl = (poolId: string, protocol: RangeAprProtocol) => protocol === "raydium-clmm"
  ? `/api/pool-range-apr?poolId=${encodeURIComponent(poolId)}`
  : `/api/protocol-pools/range-apr?protocol=${protocol}&poolId=${encodeURIComponent(poolId)}`;

async function request(poolId: string, protocol: RangeAprProtocol): Promise<PoolRangeAprPayload> {
  const response = await fetch(rangeAprUrl(poolId, protocol), {
    headers: { Accept: "application/json" },
  });
  const body = await response.json() as PoolRangeAprPayload | { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error || "Range APR estimate unavailable");
  return body as PoolRangeAprPayload;
}

export function loadPoolRangeApr(poolId: string, protocol: RangeAprProtocol = "raydium-clmm"): Promise<PoolRangeAprPayload> {
  const key = protocol === "raydium-clmm" ? `${cacheEpoch}:${poolId}` : `${cacheEpoch}:${protocol}:${poolId}`;
  return cache.get(key, () => limit(() => request(poolId, protocol)));
}

export function clearPoolRangeAprClientCache() {
  cacheEpoch += 1; // Late responses from the previous generation cannot refill the new key.
  cache.clear();
}
