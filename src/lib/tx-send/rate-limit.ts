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

/** In-memory sliding-minute limiter keyed by any string (IP, permit, wallet). Per instance; see each user's limits note. */
export function slidingWindowLimiter(limit: number) {
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

/**
 * `/api/tx-simulate` (pre-wallet guard): a step simulates at most twice per prepare (each prepare has its own permit),
 * so a permit needs few; per wallet leaves room for a multi-step run plus Try again.
 */
export const TX_SIMULATE_REQUESTS_PER_IP_PER_MINUTE = 20;
export const TX_SIMULATE_REQUESTS_PER_CHECK_PER_MINUTE = 4;
export const TX_SIMULATE_REQUESTS_PER_WALLET_PER_MINUTE = 12;
/** `/api/tx-expiry`: one voided prompt is polled every 4 s until its blockhash has expired (~1–2 min). */
export const TX_EXPIRY_REQUESTS_PER_IP_PER_MINUTE = 30;
export const TX_EXPIRY_REQUESTS_PER_CHECK_PER_MINUTE = 20;
export const TX_EXPIRY_REQUESTS_PER_WALLET_PER_MINUTE = 30;
const txSimulate = slidingWindowLimiter(TX_SIMULATE_REQUESTS_PER_IP_PER_MINUTE);
const txSimulateCheck = slidingWindowLimiter(TX_SIMULATE_REQUESTS_PER_CHECK_PER_MINUTE);
const txSimulateWallet = slidingWindowLimiter(TX_SIMULATE_REQUESTS_PER_WALLET_PER_MINUTE);
const txExpiry = slidingWindowLimiter(TX_EXPIRY_REQUESTS_PER_IP_PER_MINUTE);
const txExpiryCheck = slidingWindowLimiter(TX_EXPIRY_REQUESTS_PER_CHECK_PER_MINUTE);
const txExpiryWallet = slidingWindowLimiter(TX_EXPIRY_REQUESTS_PER_WALLET_PER_MINUTE);
export const txSimulateRateLimited = (ip: string, now = Date.now()) => txSimulate.limited(ip, now);
/** Like `txLandedCheckRateLimited`: only after the permit is verified. */
export const txSimulateCheckRateLimited = (permit: string, wallet: string, now = Date.now()) =>
  txSimulateCheck.limited(permit, now) || txSimulateWallet.limited(wallet, now);
export const txExpiryRateLimited = (ip: string, now = Date.now()) => txExpiry.limited(ip, now);
export const txExpiryCheckRateLimited = (permit: string, wallet: string, now = Date.now()) =>
  txExpiryCheck.limited(permit, now) || txExpiryWallet.limited(wallet, now);

/** Test hook. */
export function resetTxSendRateLimit() {
  txSend.reset(); txLanded.reset(); txLandedCheck.reset(); txLandedWallet.reset();
  txSimulate.reset(); txSimulateCheck.reset(); txSimulateWallet.reset(); txExpiry.reset(); txExpiryCheck.reset(); txExpiryWallet.reset();
}
