import { AsyncCache } from "@/lib/async-cache";
import { createConcurrencyLimit } from "@/lib/concurrency-limit";
import type { PoolRangeAprPayload } from "@/lib/range-apr/types";

/**
 * Browser fetcher for `/api/pool-range-apr`. Every consumer (pairs table rows and the Create position
 * modal) goes through here, so a pool is requested once per minute no matter how many components ask, and
 * the table never opens more than two requests at a time.
 */
const limit = createConcurrencyLimit(2);
/** A degraded payload (no estimates) is kept only briefly so the next ask hits the server again. */
const DEGRADED_TTL_MS = 8_000;
const cache = new AsyncCache<PoolRangeAprPayload>({
  ttlMs: 60_000, failureTtlMs: 10_000, ttlFor: (payload) => (payload.sample.degraded ? DEGRADED_TTL_MS : 60_000),
});

async function request(poolId: string): Promise<PoolRangeAprPayload> {
  const response = await fetch(`/api/pool-range-apr?poolId=${encodeURIComponent(poolId)}`, {
    headers: { Accept: "application/json" },
  });
  const body = await response.json() as PoolRangeAprPayload | { error?: string };
  if (!response.ok) throw new Error((body as { error?: string }).error || "Range APR estimate unavailable");
  return body as PoolRangeAprPayload;
}

export function loadPoolRangeApr(poolId: string): Promise<PoolRangeAprPayload> {
  return cache.get(poolId, () => limit(() => request(poolId)));
}

export function clearPoolRangeAprClientCache() {
  cache.clear();
}
