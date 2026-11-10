import "server-only";
/**
 * Server glue for the Performance stock view, shared by the Raydium, Meteora and Orca performance readers: picks the
 * base-side share quote and reuses the existing report's token-equivalent and USD metrics. No extra price reads.
 * Same-stock pools only (a token-equivalent exists); null otherwise. Never throws.
 */
import type { TokenPriceQuote } from "@sofinance/engine/token-prices";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import type { PositionCashflowEvent } from "./position-performance-events";
import type { StockPerformance } from "./position-performance-report";
import { computeStockPerformance } from "./stock-performance";

export async function buildStockPerformance(input: {
  history: ReadonlyArray<{ blockTime: number | null; events: readonly PositionCashflowEvent[] }>;
  positionId: string;
  poolId: string;
  mintA: string;
  mintB: string;
  decimalsA: number;
  decimalsB: number;
  tokenNative: TokenNativeMetrics;
  metrics: { currentEquityUsd: number | null; feesEarnedUsd: number | null };
  incomplete: boolean;
  quotes: ReadonlyMap<string, TokenPriceQuote>;
  nowSeconds: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}): Promise<StockPerformance | null> {
  const te = input.tokenNative.tokenEquivalent;
  if (!te) return null;
  try {
    const baseMint = te.baseSide === "A" ? input.mintA : input.mintB;
    // Share amounts use the report's base-side token-equivalent unit. Do not
    // multiply them by the other mint's price just because it has more liquidity.
    const priceMint = input.quotes.has(baseMint) ? baseMint : null;
    const quote = priceMint ? input.quotes.get(priceMint)! : null;
    const stock = computeStockPerformance({
      history: input.history,
      positionId: input.positionId,
      poolId: input.poolId,
      decimalsA: input.decimalsA,
      decimalsB: input.decimalsB,
      tokenEquivalent: te,
      incomplete: input.incomplete,
      quote: quote && priceMint ? { mint: priceMint, usdPrice: quote.price, priceChange24hPct: quote.priceChange24hPct ?? null } : null,
      daily: null,
      hourly: null,
      historySource: null,
      nowSeconds: input.nowSeconds,
    });
    // Preserve the existing report valuation (both token sides at their own USD
    // prices), rather than repricing token-equivalent amounts with one mint.
    return { ...stock, valueUsd: input.metrics.currentEquityUsd, feeUsd: input.metrics.feesEarnedUsd };
  } catch {
    return null;
  }
}
