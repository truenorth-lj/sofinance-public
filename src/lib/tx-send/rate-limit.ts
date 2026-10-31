/**
 * Per-IP limiter for `/api/tx-send` (same in-memory sliding-window pattern as the
 * Robinhood Chain position scan). Per instance; generous for real users, who send a
 * handful of transactions a minute, and a cheap brake on scripted abuse.
 */
const WINDOW_MS = 60_000;
export const TX_SEND_REQUESTS_PER_IP_PER_MINUTE = 20;
/**
 * `/api/tx-landed` polls about every 5 s per check while a blockhash expires (12/min). Per IP leaves room for two
 * checks at once (a cancel checked in the background plus a resubmit); per check permit caps one check; per wallet
 * caps one wallet across IPs. Each request makes at most LANDED_MAX_RPC_CALLS_PER_REQUEST RPC calls.
 */
export const TX_LANDED_REQUESTS_PER_IP_PER_MINUTE = 25;
export const TX_LANDED_REQUESTS_PER_CHECK_PER_MINUTE = 15;
export const TX_LANDED_REQUESTS_PER_WALLET_PER_MINUTE = 30;

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
const txLandedCheck = slidingWindowLimiter(TX_LANDED_REQUESTS_PER_CHECK_PER_MINUTE);
const txLandedWallet = slidingWindowLimiter(TX_LANDED_REQUESTS_PER_WALLET_PER_MINUTE);

export const txSendRateLimited = (ip: string, now = Date.now()) => txSend.limited(ip, now);
export const txLandedRateLimited = (ip: string, now = Date.now()) => txLanded.limited(ip, now);
/** Per check permit and per wallet (after the permit is verified, so a forged request cannot burn someone's budget). */
export const txLandedCheckRateLimited = (permit: string, wallet: string, now = Date.now()) =>
  txLandedCheck.limited(permit, now) || txLandedWallet.limited(wallet, now);

/** Test hook. */
export function resetTxSendRateLimit() { txSend.reset(); txLanded.reset(); txLandedCheck.reset(); txLandedWallet.reset(); }
