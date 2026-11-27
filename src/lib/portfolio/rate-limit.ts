import { clientIp } from "@/lib/request-origin/client-ip";
import { slidingWindowLimiter } from "@/lib/tx-send/rate-limit";
import { PORTFOLIO_POLL_DELAYS_MS } from "./model";

/** Requests one Portfolio page load makes for a wallet of up to MAX_PORTFOLIO_POSITIONS positions: the first read plus every follow-up. */
export const PORTFOLIO_REQUESTS_PER_LOAD = 1 + PORTFOLIO_POLL_DELAYS_MS.length;

/**
 * Per-IP budget for `POST /api/portfolio`, its own sliding minute (P6). It used to share the 12/min budget of
 * `/api/dex/*` positions/performance, so a load (up to 6 requests) plus the page's discovery reads plus one Refresh could
 * reach 429 and blank every row. The aggregate is cheaper per request than a discovery scan: history comes from the
 * database, never from RPC on the request path, and position accounts are batched.
 *
 * 40 = room for 6 full loads in a minute (first load, a few Refreshes, a second tab), each with its whole follow-up
 * schedule, and some headroom. Same design limits as `dex-route-rate-limit.ts`: per server instance, keyed by
 * `clientIp()` (`request-origin/client-ip.ts`), bounded memory. It is a brake on hammering, not a quota.
 */
export const PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE = 40;
export const PORTFOLIO_RETRY_AFTER_SECONDS = 60;

const requests = slidingWindowLimiter(PORTFOLIO_REQUESTS_PER_IP_PER_MINUTE);

export function portfolioRateLimited(request: Request, now = Date.now()): boolean {
  return requests.limited(clientIp(request), now);
}

/** Test hook. */
export function resetPortfolioRateLimit() { requests.reset(); }
