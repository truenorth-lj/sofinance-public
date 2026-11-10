/** Presentation of existing position metrics plus the recorded deposit-time entry (`stock-entry.ts`).
 * No candle-based entry estimate or synthetic sparkline: candles are not deposit-time prices.
 * USD valuations are supplied by the existing report reader in the server glue.
 */
import type { PositionCashflowEvent } from "./position-performance-events";
import type { StockPerformance } from "./position-performance-report";
import type { StockEntry } from "./stock-cost-basis";

/** Retained for the isolated historical-price utility; not used by this view. */
export type PriceClose = { time: number; close: number };
export type StockPerformanceInput = {
  history: ReadonlyArray<{ blockTime: number | null; events: readonly PositionCashflowEvent[] }>;
  positionId: string;
  poolId: string;
  decimalsA: number;
  decimalsB: number;
  tokenEquivalent: {
    baseSymbol: string;
    baseSide: "A" | "B";
    uiPriceBPerA: number;
    metrics: { equity: number; feesEarned: number };
  };
  incomplete: boolean;
  quote: { mint: string; usdPrice: number; priceChange24hPct: number | null } | null;
  /** Legacy inputs are deliberately ignored: candles are not deposit-time prices. */
  daily: readonly PriceClose[] | null;
  hourly: readonly PriceClose[] | null;
  historySource: string | null;
  nowSeconds: number;
  /** Shares put in and their average recorded deposit-time price, in the base-side unit; absent when not recorded. */
  entry?: StockEntry | null;
  /** The report's own USD valuations (both sides at their own prices). */
  valuation?: { valueUsd: number | null; feeUsd: number | null };
};

/** Legacy candle helper, not a cost-basis calculation. */
export function dailyCloseAt(daily: readonly PriceClose[], time: number): number | null {
  const dayStart = Math.floor(time / 86_400) * 86_400;
  for (const candle of daily) {
    if (candle.time < dayStart) continue;
    return candle.time - dayStart > 3 * 86_400 ? null : candle.close;
  }
  return null;
}
export function downsample(values: readonly number[], max = 60): number[] {
  if (values.length <= max) return [...values];
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]!);
}

export function computeStockPerformance(input: StockPerformanceInput): StockPerformance {
  const te = input.tokenEquivalent;
  const opened = input.history.find((item) => item.events.some((event) =>
    event.kind === "open" && event.poolState === input.poolId));
  const firstTime = opened?.blockTime ?? null;
  const entry = input.incomplete ? null : input.entry ?? null;
  const priceUsd = input.quote?.usdPrice ?? null;
  const sharesIn = entry?.sharesIn ?? null, entryPriceUsd = entry?.entryPriceUsd ?? null;
  const feeUsd = input.valuation?.feeUsd ?? null;
  const priceChangeUsd = sharesIn !== null && entryPriceUsd !== null && priceUsd !== null ? sharesIn * (priceUsd - entryPriceUsd) : null;
  const priceChangePct = entryPriceUsd !== null && entryPriceUsd > 0 && priceUsd !== null ? (priceUsd / entryPriceUsd - 1) * 100 : null;
  return {
    symbol: te.baseSymbol,
    priceMint: input.quote?.mint ?? null,
    priceUsd: input.quote?.usdPrice ?? null,
    change24hPct: input.quote?.priceChange24hPct ?? null,
    sharesNow: te.metrics.equity,
    // Only the existing per-side USD valuation is authoritative. The builder
    // supplies it; the token-equivalent share price must not replace it.
    valueUsd: input.valuation?.valueUsd ?? null,
    sharesIn,
    firstDepositAtIso: firstTime !== null ? new Date(firstTime * 1000).toISOString() : null,
    entryPriceUsd,
    priceChangeUsd,
    priceChangePct,
    feeShares: te.metrics.feesEarned,
    feeUsd,
    totalUsd: priceChangeUsd !== null && feeUsd !== null ? priceChangeUsd + feeUsd : null,
    sparkline24h: [],
    sparklineSinceEntry: [],
    entryPriceSource: entryPriceUsd !== null ? entry?.source ?? null : null,
    entryUnavailableReason: entryPriceUsd !== null ? null : input.incomplete
      ? "Position history is incomplete. Entry price was not recorded."
      : entry?.reason ?? "Entry price was not recorded for this position.",
  };
}
