/** Presentation of existing position metrics plus the recorded deposit-time entry (`stock-entry.ts`).
 * No candle-based entry estimate or synthetic sparkline: candles are not deposit-time prices.
 * USD valuations are supplied by the existing report reader in the server glue.
 *
 * Units (X3-6). The report's amounts and the recorded entry prices are per raw token unit (raw / 10^decimals); the
 * shown figures are per share, at the base mint's multiplier now (shares = raw units × multiplier). The entry price is
 * shown at today's multiplier too (split- and dividend-adjusted, as a broker adjusts cost basis), so no deposit-time
 * multiplier is needed: price change = raw units in × (USD per raw unit now − entry USD per raw unit), the same figure
 * either way. With an unknown multiplier there are no share figures, so there is no stock view.
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
  /** The base mint's quote, for its mint and 24h change only (its price is in `basePricing`, unit-checked). */
  quote: { mint: string; priceChange24hPct: number | null } | null;
  /**
   * The base mint through the asset registry, never pair-guard corrected: USD per raw unit (multiplier applied to a
   * per-share quote, never to a per-raw one; null when unpriced) and the multiplier now (known, positive).
   */
  basePricing: { usdPerRawUnit: number | null; multiplier: number };
  /** Legacy inputs are deliberately ignored: candles are not deposit-time prices. */
  daily: readonly PriceClose[] | null;
  hourly: readonly PriceClose[] | null;
  historySource: string | null;
  nowSeconds: number;
  /** Raw units put in and their average recorded deposit-time USD per raw unit (base side); absent when not recorded. */
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
  const { usdPerRawUnit, multiplier } = input.basePricing;
  const opened = input.history.find((item) => item.events.some((event) =>
    event.kind === "open" && event.poolState === input.poolId));
  const firstTime = opened?.blockTime ?? null;
  // Keep a recorded entry when history is incomplete only if the price is finite
  // and this history includes the position's opening event.
  const stored = input.entry ?? null;
  const recorded = typeof stored?.entryPriceUsd === "number" && Number.isFinite(stored.entryPriceUsd) && opened;
  const entry = recorded ? stored : input.incomplete ? null : stored;
  const unitsIn = entry?.sharesIn ?? null, entryUsdPerRawUnit = entry?.entryPriceUsd ?? null;
  const toShares = (units: number) => units * multiplier;
  const priceUsd = usdPerRawUnit !== null ? usdPerRawUnit / multiplier : null;
  const entryPriceUsd = entryUsdPerRawUnit !== null ? entryUsdPerRawUnit / multiplier : null;
  const feeUsd = input.valuation?.feeUsd ?? null;
  const priceChangeUsd = unitsIn !== null && entryUsdPerRawUnit !== null && usdPerRawUnit !== null
    ? unitsIn * (usdPerRawUnit - entryUsdPerRawUnit) : null;
  const priceChangePct = entryUsdPerRawUnit !== null && entryUsdPerRawUnit > 0 && usdPerRawUnit !== null
    ? (usdPerRawUnit / entryUsdPerRawUnit - 1) * 100 : null;
  return {
    symbol: te.baseSymbol,
    priceMint: input.quote?.mint ?? null,
    priceUsd,
    change24hPct: input.quote?.priceChange24hPct ?? null,
    sharesNow: toShares(te.metrics.equity),
    // Only the existing per-side USD valuation is authoritative. The builder
    // supplies it; the token-equivalent share price must not replace it.
    valueUsd: input.valuation?.valueUsd ?? null,
    sharesIn: unitsIn !== null ? toShares(unitsIn) : null,
    firstDepositAtIso: firstTime !== null ? new Date(firstTime * 1000).toISOString() : null,
    entryPriceUsd,
    priceChangeUsd,
    priceChangePct,
    feeShares: toShares(te.metrics.feesEarned),
    feeUsd,
    totalUsd: priceChangeUsd !== null && feeUsd !== null ? priceChangeUsd + feeUsd : null,
    sparkline24h: [],
    sparklineSinceEntry: [],
    entryPriceSource: entryPriceUsd !== null && entry?.source
      ? multiplier === 1 ? entry.source : `${entry.source}; per share at today's ${formatMultiplier(multiplier)} multiplier`
      : null,
    entryUnavailableReason: entryPriceUsd !== null ? null : input.incomplete
      ? "Position history is incomplete. Entry price was not recorded."
      : entry?.reason ?? "Entry price was not recorded for this position.",
  };
}

const formatMultiplier = (multiplier: number) => `×${Number(multiplier.toPrecision(6))}`;
