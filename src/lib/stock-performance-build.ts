import "server-only";
/**
 * Server glue for the Performance stock view, shared by the Raydium, Meteora and Orca performance readers: picks the
 * share price (the pool side with more Jupiter liquidity), loads past prices, and computes `StockPerformance`.
 * Same-stock pools only (a token-equivalent exists); null otherwise. Never throws.
 */
import type { JupiterPriceQuote } from "@sofinance/engine/token-prices";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import type { PositionCashflowEvent } from "./position-performance-events";
import type { StockPerformance } from "./position-performance-report";
import { computeStockPerformance } from "./stock-performance";
import { loadStockPriceHistory } from "./stock-price-history";

export async function buildStockPerformance(input: {
  history: ReadonlyArray<{ blockTime: number | null; events: readonly PositionCashflowEvent[] }>;
  positionId: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tokenNative: TokenNativeMetrics;
  incomplete: boolean;
  quotes: ReadonlyMap<string, JupiterPriceQuote>;
  nowSeconds: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StockPerformance | null> {
  const te = input.tokenNative.tokenEquivalent;
  if (!te) return null;
  try {
    const baseMint = te.baseSide === "A" ? input.mintA : input.mintB;
    const otherMint = baseMint === input.mintA ? input.mintB : input.mintA;
    const depth = (mint: string) => input.quotes.get(mint)?.liquidityUsd ?? -1;
    const priceMint = [baseMint, otherMint].filter((mint) => input.quotes.has(mint))
      .sort((a, b) => depth(b) - depth(a))[0] ?? null;
    const quote = priceMint ? input.quotes.get(priceMint)! : null;
    const prices = await loadStockPriceHistory(priceMint ? [priceMint, priceMint === baseMint ? otherMint : baseMint] : [baseMint, otherMint],
      { fetcher: input.fetcher, signal: input.signal });
    return computeStockPerformance({
      history: input.history,
      positionId: input.positionId,
      poolId: input.poolId,
      decimalsA: input.decimalsA,
      decimalsB: input.decimalsB,
      tokenEquivalent: te,
      incomplete: input.incomplete,
      quote: quote && priceMint ? { mint: priceMint, usdPrice: quote.usdPrice, priceChange24hPct: quote.priceChange24hPct } : null,
      daily: prices?.daily ?? null,
      hourly: prices?.hourly ?? null,
      historySource: prices?.source ?? null,
      nowSeconds: input.nowSeconds,
    });
  } catch {
    return null;
  }
}
