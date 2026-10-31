import type { LandedLookupResult } from "./lookup";

/** Identical `/api/tx-landed` polls within this window share one answer (a reload, two tabs, a retried request). */
export const LANDED_RESULT_CACHE_MS = 2_000;
const cache = new Map<string, { at: number; result: LandedLookupResult }>();

export function cachedLandedResult(key: string, now = Date.now()) {
  const hit = cache.get(key);
  return hit && now - hit.at < LANDED_RESULT_CACHE_MS ? hit.result : null;
}

export function cacheLandedResult(key: string, result: LandedLookupResult, now = Date.now()) {
  for (const [entry, value] of cache) if (now - value.at >= LANDED_RESULT_CACHE_MS) cache.delete(entry);
  cache.set(key, { at: now, result });
}

/** Test hook. */
export function resetTxLandedCache() { cache.clear(); }
