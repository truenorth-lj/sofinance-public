/**
 * Per-IP limit for Robinhood Chain position scans (sliding minute, per instance).
 * Shared by GET /api/rhc-univ4-positions, GET /api/rhc-univ4-position-values, and the
 * generic `/api/dex/uniswap-v4-rhc/positions` module hook, so one client cannot bypass
 * the dedicated-route budget by hitting the generic path.
 *
 * This file is data/limit only: no RPC, no server-only, no engine.
 */

const WINDOW_MS = 60_000;
export const REQUESTS_PER_IP_PER_MINUTE = 20;
const hits = new Map<string, number[]>();

/** Same IP parsing as GET /api/rhc-univ4-positions. */
export function rhcScanClientIp(request: Request): string {
  return request.headers.get("x-real-ip")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

/** Per-IP request limit (sliding minute, per instance). */
export function rhcScanRateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_IP_PER_MINUTE) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.delete(ip); hits.set(ip, recent);
  while (hits.size > 5_000) hits.delete(hits.keys().next().value!);
  return false;
}

/** Test hook. Also called from `resetRhcScanCache`. */
export function resetRhcScanRateLimit(): void {
  hits.clear();
}
