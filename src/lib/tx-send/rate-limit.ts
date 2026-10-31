/**
 * Per-IP limiter for `/api/tx-send` (same in-memory sliding-window pattern as the
 * Robinhood Chain position scan). Per instance; generous for real users, who send a
 * handful of transactions a minute, and a cheap brake on scripted abuse.
 */
const WINDOW_MS = 60_000;
export const TX_SEND_REQUESTS_PER_IP_PER_MINUTE = 20;
const hits = new Map<string, number[]>();

export const clientIp = (request: Request) => request.headers.get("x-real-ip")?.trim()
  || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";

export function txSendRateLimited(ip: string, now = Date.now()): boolean {
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= TX_SEND_REQUESTS_PER_IP_PER_MINUTE) { hits.set(ip, recent); return true; }
  recent.push(now);
  hits.delete(ip); hits.set(ip, recent);
  while (hits.size > 5_000) hits.delete(hits.keys().next().value!);
  return false;
}

/** Test hook. */
export function resetTxSendRateLimit() { hits.clear(); }
