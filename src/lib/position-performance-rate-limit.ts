import { clientIp } from "@/lib/request-origin/client-ip";
import { slidingWindowLimiter } from "@/lib/tx-send/rate-limit";

/**
 * Per-IP limits for `GET /api/position-performance`. Same in-memory sliding-minute limiter as `/api/mcp`, `/api/dex/*`
 * and `/api/tx-send`: no paid service, no platform setting.
 *
 * - Position lookups: POSITION_PERFORMANCE_LOOKUPS_PER_IP_PER_MINUTE distinct positions per minute, the same
 *   12/min budget as MCP position reads and `/api/dex/*` positions/performance. Repeat requests for a position this IP
 *   already looked up in the last minute do not count again: one Performance view is up to 5 sequential requests (the
 *   panel continues a truncated history in the same view, and the server response is `no-store`), so counting
 *   requests would refuse a normal user opening 3 long-history positions in a minute.
 * - Every request: POSITION_PERFORMANCE_REQUESTS_PER_IP_PER_MINUTE (12 lookups x 5 continuation steps), the brake
 *   on hammering one position.
 * A request refused by the request limit is not counted as a lookup.
 *
 * Same limits of this design as `mcp-rate-limit.ts`: per server instance, not global; keyed by `clientIp()`
 * (`request-origin/client-ip.ts`); bounded memory (5,000 keys per map).
 */
export const POSITION_PERFORMANCE_LOOKUPS_PER_IP_PER_MINUTE = 12;
export const POSITION_PERFORMANCE_REQUESTS_PER_IP_PER_MINUTE = 60;
export const POSITION_PERFORMANCE_RETRY_AFTER_SECONDS = 60;
const WINDOW_MS = 60_000;
const MAX_SEEN = 5_000;

type PositionPerformanceRateScope = "requests" | "lookups";

const requests = slidingWindowLimiter(POSITION_PERFORMANCE_REQUESTS_PER_IP_PER_MINUTE);
const lookups = slidingWindowLimiter(POSITION_PERFORMANCE_LOOKUPS_PER_IP_PER_MINUTE);
/** `${ip} ${positionMint}` -> time of the counted lookup. */
const seen = new Map<string, number>();

/** The limit this request is over, or null. Call after validating `positionMint`. */
export function positionPerformanceRateLimited(request: Request, positionMint: string, now = Date.now()): PositionPerformanceRateScope | null {
  const ip = clientIp(request);
  if (requests.limited(ip, now)) return "requests";
  const key = `${ip} ${positionMint}`;
  const counted = seen.get(key);
  if (counted !== undefined && now - counted < WINDOW_MS) return null;
  if (lookups.limited(ip, now)) return "lookups";
  seen.delete(key);
  seen.set(key, now);
  while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value!);
  return null;
}

/** Test hook. */
export function resetPositionPerformanceRateLimit() { requests.reset(); lookups.reset(); seen.clear(); }
