import { rangeAprRequestTarget, type RangeAprProtocol, type RangeAprOptions } from "@/lib/dex/client";
export type { RangeAprProtocol, RangeAprOptions } from "@/lib/dex/client";
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

/**
 * Raydium pools use `/api/pool-range-apr`; Orca / Meteora use the flag-gated `/api/protocol-pools/range-apr` (same payload
 * shape). Meteora pools listed by `/api/rwa-pairs` (feed `meteora-dlmm-rwa-v1`) have their APR saved by the RWA cron, so
 * they read that saved snapshot from `/api/pool-range-apr` like Raydium (`rwaList: true`).
 */
export const rangeAprUrl = (poolId: string, protocol: RangeAprProtocol, options?: RangeAprOptions) =>
  rangeAprRequestTarget(poolId, protocol, options).url;

async function request(url: string): Promise<PoolRangeAprPayload> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const body = await response.json() as PoolRangeAprPayload | { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error || "Range APR estimate unavailable");
  return body as PoolRangeAprPayload;
}

export function loadPoolRangeApr(poolId: string, protocol: RangeAprProtocol = "raydium-clmm",
  options?: RangeAprOptions): Promise<PoolRangeAprPayload> {
  const target = rangeAprRequestTarget(poolId, protocol, options);
  return cache.get(`${cacheEpoch}:${target.cacheKey}`, () => limit(() => request(target.url)));
}

export function clearPoolRangeAprClientCache() {
  cacheEpoch += 1; // Late responses from the previous generation cannot refill the new key.
  cache.clear();
}
