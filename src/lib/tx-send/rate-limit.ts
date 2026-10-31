/**
 * Per-IP limiter for `/api/tx-send` (same in-memory sliding-window pattern as the
 * Robinhood Chain position scan). Per instance; generous for real users, who send a
 * handful of transactions a minute, and a cheap brake on scripted abuse.
 */
const WINDOW_MS = 60_000;
export const TX_SEND_REQUESTS_PER_IP_PER_MINUTE = 20;
/** `/api/tx-landed` polls every few seconds while it waits for a blockhash to expire, so it gets more room. */
export const TX_LANDED_REQUESTS_PER_IP_PER_MINUTE = 60;

export const clientIp = (request: Request) => request.headers.get("x-real-ip")?.trim()
  || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

function slidingWindowLimiter(limit: number) {
  const hits = new Map<string, number[]>();
  const limited = (ip: string, now = Date.now()): boolean => {
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) { hits.set(ip, recent); return true; }
    recent.push(now);
    hits.delete(ip); hits.set(ip, recent);
    while (hits.size > 5_000) hits.delete(hits.keys().next().value!);
    return false;
  };
  return { limited, reset: () => hits.clear() };
}

const txSend = slidingWindowLimiter(TX_SEND_REQUESTS_PER_IP_PER_MINUTE);
const txLanded = slidingWindowLimiter(TX_LANDED_REQUESTS_PER_IP_PER_MINUTE);

export const txSendRateLimited = (ip: string, now = Date.now()) => txSend.limited(ip, now);
export const txLandedRateLimited = (ip: string, now = Date.now()) => txLanded.limited(ip, now);

/** Test hook. */
export function resetTxSendRateLimit() { txSend.reset(); txLanded.reset(); }
