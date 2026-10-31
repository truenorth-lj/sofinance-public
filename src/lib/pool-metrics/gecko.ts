import { ThrottleGate } from "../range-apr/throttle-gate";

/**
 * The one GeckoTerminal client config shared by every pool-metrics path (range APR, daily APR history,
 * Robinhood Chain market-data fallback): base URL per network and ONE per-instance rate limit.
 *
 * GeckoTerminal is rate limited per egress IP (~30/min) and serverless IPs are shared with other tenants: one
 * call at a time per instance, spaced apart, and a cooldown after a 429 (see `throttle-gate.ts`). A 429 seen on
 * any path cools every path down.
 */
export type GeckoNetwork = "solana" | "robinhood";

export const GECKO_TERMINAL_API = "https://api.geckoterminal.com/api/v2";

/** `https://api.geckoterminal.com/api/v2/networks/{network}/pools` */
export const geckoPoolsUrl = (network: GeckoNetwork) => `${GECKO_TERMINAL_API}/networks/${network}/pools`;

/** OHLCV candles for one pool. Pool ids are case-sensitive on Solana and lowercase hex on EVM networks. */
export function geckoOhlcvUrl(network: GeckoNetwork, poolId: string, timeframe: "day" | "hour", query: { limit: number; currency: "usd" | "token" }): string {
  const id = network === "solana" ? poolId : poolId.toLowerCase();
  return `${geckoPoolsUrl(network)}/${encodeURIComponent(id)}/ohlcv/${timeframe}?aggregate=1&limit=${query.limit}&currency=${query.currency}`;
}

/** Page / API requests (one call at a time, refused during a cooldown so a page never waits on a 429). */
export const geckoGate = new ThrottleGate({ minSpacingMs: 250, defaultCooldownMs: 20_000 });

/**
 * Cron (`rwa-apr-refresh`): GeckoTerminal calls start at least this far apart for the whole run (Solana and RHC
 * pools share one sequential queue), i.e. at most 5 calls/min.
 * Why 12 s: the keyless API we call has one rate pool per source IP, documented at "~5 calls/min, dynamic, varies by
 * server load" (docs.coingecko.com/docs/keyless-public-api, read 11/1; the older ~10/min and ~30/min pages are out of
 * date). Vercel functions leave from shared egress IPs, so other tenants draw on the same pool. Measured 11/1 00:15
 * Taipei run: 8 calls at 2.5 s spacing (1 icon tokens/multi, 1 pools/multi, 3 pools × 2 candle calls) went through
 * in ~25 s, the 9th got a 429 with no other request of ours in flight. That is a burst allowance (~8) used up at
 * ~24/min, not a long-run per-minute count, so the fix is to stay at the documented refill rate, not to retry.
 */
export const CRON_GECKO_SPACING_MS = 12_000;

/**
 * One GeckoTerminal gate per cron run, used by every pool in the queue. A 429 sets its sticky `hit429` flag and
 * blocks it for the rest of the run (`stickyBlock`: it never reopens after the cooldown), which ends the run:
 * nothing waits out a cooldown, the remaining pools go first next run. One attempt per call (`maxAttempts: 1`), so
 * no retry ever starts inside a slot without the 12 s spacing.
 */
export function createCronGeckoGate(options: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {}): ThrottleGate {
  return new ThrottleGate({
    minSpacingMs: CRON_GECKO_SPACING_MS, defaultCooldownMs: 20_000, minCooldownMs: 5_000, maxCooldownMs: 60_000,
    stickyBlock: true, maxAttempts: 1, ...options,
  });
}
