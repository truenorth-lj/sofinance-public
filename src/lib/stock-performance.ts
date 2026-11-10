/** Presentation of existing position metrics, not a second cost-basis ledger.
 * No historical-price lookup, candle-based entry estimate or synthetic sparkline.
 * USD valuations are supplied by the existing report reader in the server glue.
 */
import type { PositionCashflowEvent } from "./position-performance-events";
import type { StockPerformance } from "./position-performance-report";

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
  return {
    symbol: te.baseSymbol,
    priceMint: input.quote?.mint ?? null,
    priceUsd: input.quote?.usdPrice ?? null,
    change24hPct: input.quote?.priceChange24hPct ?? null,
    sharesNow: te.metrics.equity,
    // Only the existing per-side USD valuation is authoritative. The builder
    // supplies it; the token-equivalent share price must not replace it.
    valueUsd: null,
    sharesIn: null,
    firstDepositAtIso: firstTime !== null ? new Date(firstTime * 1000).toISOString() : null,
    entryPriceUsd: null,
    priceChangeUsd: null,
    priceChangePct: null,
    feeShares: te.metrics.feesEarned,
    feeUsd: null,
    totalUsd: null,
    sparkline24h: [],
    sparklineSinceEntry: [],
    entryPriceSource: null,
    entryUnavailableReason: input.incomplete
      ? "Position history is incomplete. Entry price was not recorded."
      : "Entry price was not recorded for this position.",
  };
}
