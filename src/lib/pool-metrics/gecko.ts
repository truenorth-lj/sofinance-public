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

export const geckoGate = new ThrottleGate({ minSpacingMs: 250, defaultCooldownMs: 20_000 });
