import "server-only";
/**
 * Server glue for the Performance stock view, shared by the Raydium, Meteora and Orca performance readers: picks the
 * base-side share quote and reuses the existing report's token-equivalent and USD metrics. The only extra reads are the
 * recorded deposit-time entry prices (`stock-entry.ts`: stored rows, at most a few RPC lookups per view, never candles).
 * The base mint's price and multiplier come from the report's registry pricing, before the pair guard (a single-asset
 * display; X3-6). Same-stock pools only (a token-equivalent exists) with a known base multiplier; null otherwise.
 * Never throws.
 */
import type { TokenPriceQuote } from "@sofinance/engine/token-prices";
import type { TokenNativeMetrics } from "@sofinance/engine/position-performance-math";
import type { PositionCashflowEvent } from "./position-performance-events";
import { ownUsdPerRawUnit } from "@sofinance/engine/valuation/pair-pricing";
import type { PositionPricingReport, StockPerformance } from "./position-performance-report";
import { computeStockPerformance } from "./stock-performance";
import { resolveStockEntry, type StockEntryDeps } from "./stock-entry";

export async function buildStockPerformance(input: {
  history: ReadonlyArray<{ signature: string; slot: number; blockTime: number | null; events: readonly PositionCashflowEvent[] }>;
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
  /** The report's registry pricing of both sides (multiplier at evaluation time; guard recorded, not applied here). */
  pricing: Pick<PositionPricingReport, "usdPerRawUnitA" | "usdPerRawUnitB" | "multiplierA" | "multiplierB" | "guard">;
  nowSeconds: number;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  /** Test seam for the entry-price store and RPC. */
  entryDeps?: StockEntryDeps;
}): Promise<StockPerformance | null> {
  const te = input.tokenNative.tokenEquivalent;
  if (!te) return null;
  try {
    const baseMint = te.baseSide === "A" ? input.mintA : input.mintB;
    const side = te.baseSide === "A" ? "a" : "b";
    const multiplier = side === "a" ? input.pricing.multiplierA : input.pricing.multiplierB;
    // Unknown is never treated as 1: without it the raw amounts cannot be shown as shares.
    if (typeof multiplier !== "number" || !Number.isFinite(multiplier) || multiplier <= 0) return null;
    const usdPerRawUnit = ownUsdPerRawUnit({ side, guard: input.pricing.guard,
      usdPerRawUnit: side === "a" ? input.pricing.usdPerRawUnitA : input.pricing.usdPerRawUnitB });
    // Share amounts use the report's base-side token-equivalent unit. Do not
    // multiply them by the other mint's price just because it has more liquidity.
    const priceMint = input.quotes.has(baseMint) ? baseMint : null;
    const quote = priceMint ? input.quotes.get(priceMint)! : null;
    // Still resolve an entry when history is incomplete so a recorded price can
    // surface; computeStockPerformance keeps it only when entryPriceUsd is finite
    // and the history includes this position's opening event.
    const entry = await resolveStockEntry({
      history: input.history, positionId: input.positionId, poolId: input.poolId, mintA: input.mintA, mintB: input.mintB,
      decimalsA: input.decimalsA, decimalsB: input.decimalsB, baseSide: te.baseSide,
      uiPriceBPerA: te.uiPriceBPerA, signal: input.signal, deps: input.entryDeps,
    });
    // Preserve the existing report valuation (both token sides at their own USD
    // prices), rather than repricing token-equivalent amounts with one mint.
    return computeStockPerformance({
      history: input.history,
      positionId: input.positionId,
      poolId: input.poolId,
      decimalsA: input.decimalsA,
      decimalsB: input.decimalsB,
      tokenEquivalent: te,
      incomplete: input.incomplete,
      quote: quote && priceMint ? { mint: priceMint, priceChange24hPct: quote.priceChange24hPct ?? null } : null,
      basePricing: { usdPerRawUnit, multiplier },
      daily: null,
      hourly: null,
      historySource: null,
      nowSeconds: input.nowSeconds,
      entry,
      valuation: { valueUsd: input.metrics.currentEquityUsd, feeUsd: input.metrics.feesEarnedUsd },
    });
  } catch {
    return null;
  }
}
