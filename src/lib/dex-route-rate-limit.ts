import { clientIp, slidingWindowLimiter } from "@/lib/tx-send/rate-limit";

/**
 * Per-IP limits for `POST /api/dex/[dex]/[op]` (PM 11/1, before DEX_TX_ROUTE_ENABLED goes on in production). Same
 * in-memory sliding-minute pattern as `/api/tx-send` and the Robinhood Chain scan: no paid service, no platform setting.
 *
 * - Every op: DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE. A real open is a few quotes plus 2 steps (and a recovery if it
 *   stops halfway), far below this.
 * - `positions` also: DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE. It is the costly read (one getProgramAccounts per pool
 *   list plus bin arrays), and the page asks once per load or rescan. `performance` (PR9) shares this budget: it reads the
 *   position's signature history and parsed transactions, the other costly read, once per Performance tab open.
 *
 * Limits of this design (documented on purpose):
 * - Per server instance, not global: each warm instance keeps its own counts, so with N instances an IP can make up to
 *   N times the limit, and a cold start forgets the counts. It is a cheap brake on one client hammering, not a quota.
 * - Keyed by the platform's client IP header (`x-real-ip`, then the first `x-forwarded-for`). Users behind one NAT share
 *   a budget; a request without either header shares the "unknown" budget.
 * - Memory is bounded: at most 5,000 IPs per limiter, oldest dropped first.
 */
export const DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE = 60;
export const DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE = 12;

const route = slidingWindowLimiter(DEX_ROUTE_REQUESTS_PER_IP_PER_MINUTE);
const positions = slidingWindowLimiter(DEX_POSITIONS_REQUESTS_PER_IP_PER_MINUTE);

/** True when this request is over a limit (it is not counted against the per-op limit once the route limit refused it). */
export function dexRouteRateLimited(request: Request, op: string, now = Date.now()): boolean {
  const ip = clientIp(request);
  if (route.limited(ip, now)) return true;
  return op === "positions" || op === "performance" ? positions.limited(ip, now) : false;
}

/** Test hook. */
export function resetDexRouteRateLimit() { route.reset(); positions.reset(); }
