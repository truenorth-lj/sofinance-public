import type { TokenPriceQuote, TokenPriceSource } from "../../token-prices";
import type { MultiplierHint } from "../types";
import { isUsablePrice, type PriceSource } from "./types";

type QuoteOf<S extends TokenPriceSource> = Extract<TokenPriceQuote, { source: S }>;

function tokenPriceSource<S extends TokenPriceSource>(id: S, basis: QuoteOf<S>["basis"]): PriceSource<QuoteOf<S>> {
  return {
    id,
    basis,
    toQuote: (quote) => isUsablePrice(quote.price)
      ? { basis, usd: quote.price, source: id, ...(quote.liquidityUsd !== undefined ? { liquidityUsd: quote.liquidityUsd } : {}) }
      : null,
  };
}

/** Jupiter Price v3 `usdPrice`: per share (scaled UI). */
export const jupiterPriceSource = tokenPriceSource("jupiter", "per-share");
/** DexScreener Solana `priceUsd`: per raw unit. */
export const dexscreenerPriceSource = tokenPriceSource("dexscreener", "per-raw-unit");
/** Raydium pool mid / stable-USD fallback: per raw unit. */
export const raydiumPoolPriceSource = tokenPriceSource("raydium", "per-raw-unit");

/**
 * Jupiter's free `scaledUiConfig` as a multiplier hint. `observedAtMs` is when the response was fetched: an on-chain
 * mint read still wins, and against a stored snapshot the more recent one wins.
 */
export function multiplierHintsFromQuote(quote: TokenPriceQuote, observedAtMs: number): MultiplierHint[] {
  return quote.source === "jupiter" && quote.scaledUiConfig
    ? [{ kind: "scaled-ui-config", origin: "jupiter", observedAtMs, config: quote.scaledUiConfig }]
    : [];
}
