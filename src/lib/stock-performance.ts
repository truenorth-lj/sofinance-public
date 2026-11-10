/**
 * The stock view of a same-stock pool position (pure; no I/O): what the stock did, what the shares put in did since
 * they were put in, and what the fees added in shares. Inputs come from the position's own cashflow history, its
 * token-equivalent (TE) metrics, one Jupiter quote and the daily / hourly closes of `stock-price-history`.
 *
 * Shares: deposits and withdrawn principal are converted to shares with the same current-tick TE rate the report
 * uses, so `sharesIn`, `sharesNow` and `feeShares` share one unit.
 * Entry price: each deposit's share count × the daily close of its UTC day, averaged by shares.
 */
import { rawToUiAmount, toTokenEquivalentUi } from "@sofinance/engine/position-performance-math";
import { aggregateCashflowsForPosition, type PositionCashflowEvent } from "./position-performance-events";
import type { StockPerformance } from "./position-performance-report";

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
  /** History is cut short or misses the open: shares put in and the entry price are not known. */
  incomplete: boolean;
  quote: { mint: string; usdPrice: number; priceChange24hPct: number | null } | null;
  /** Oldest first; `time` is the candle's UTC start in seconds. */
  daily: readonly PriceClose[] | null;
  hourly: readonly PriceClose[] | null;
  historySource: string | null;
  nowSeconds: number;
};

const DAY = 86_400;
const SPARKLINE_MAX_POINTS = 60;
/** A deposit day with no candle may use the next candle up to this many days later (a quiet market day). */
const MAX_CANDLE_GAP_DAYS = 3;
const DUST_SHARES = 1e-9;

/** The close of the daily candle that covers `time`, else the next candle within MAX_CANDLE_GAP_DAYS. */
export function dailyCloseAt(daily: readonly PriceClose[], time: number): number | null {
  const dayStart = Math.floor(time / DAY) * DAY;
  for (const candle of daily) {
    if (candle.time < dayStart) continue;
    if (candle.time - dayStart > MAX_CANDLE_GAP_DAYS * DAY) return null;
    return candle.close;
  }
  return null;
}

/** At most `max` points, keeping the first and the last. */
export function downsample(values: readonly number[], max = SPARKLINE_MAX_POINTS): number[] {
  if (values.length <= max) return [...values];
  const step = (values.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => values[Math.round(i * step)]!);
}

export function computeStockPerformance(input: StockPerformanceInput): StockPerformance {
  const te = input.tokenEquivalent;
  const toShares = (a: bigint, b: bigint) => toTokenEquivalentUi(
    { a: rawToUiAmount(a, input.decimalsA), b: rawToUiAmount(b, input.decimalsB) }, te.uiPriceBPerA, te.baseSide);

  const deposits: Array<{ time: number | null; shares: number }> = [];
  let withdrawnShares = 0;
  for (const item of input.history) {
    const flows = aggregateCashflowsForPosition(item.events, input.positionId, input.poolId);
    if (flows.depositedA > 0n || flows.depositedB > 0n) deposits.push({ time: item.blockTime, shares: toShares(flows.depositedA, flows.depositedB) });
    if (flows.withdrawnPrincipalA > 0n || flows.withdrawnPrincipalB > 0n) withdrawnShares += toShares(flows.withdrawnPrincipalA, flows.withdrawnPrincipalB);
  }
  const depositedShares = deposits.reduce((sum, item) => sum + item.shares, 0);
  const firstTime = deposits.find((item) => item.time !== null)?.time ?? null;

  const priceUsd = input.quote?.usdPrice ?? null;
  const sharesNow = te.metrics.equity;
  const feeShares = te.metrics.feesEarned;

  let sharesIn: number | null = null;
  let entryPriceUsd: number | null = null;
  let entryUnavailableReason: string | null = null;
  if (input.incomplete) entryUnavailableReason = "Position history is incomplete, so the shares put in are not known yet.";
  else if (!deposits.length || depositedShares <= DUST_SHARES) entryUnavailableReason = "No deposit was found in the position history.";
  else {
    sharesIn = Math.max(0, depositedShares - withdrawnShares);
    if (!input.daily?.length) entryUnavailableReason = "Past prices for this stock are unavailable right now.";
    else if (deposits.some((item) => item.time === null)) entryUnavailableReason = "A deposit has no timestamp, so its price is unknown.";
    else {
      let weighted = 0;
      for (const item of deposits) {
        const close = dailyCloseAt(input.daily, item.time!);
        if (close === null) { weighted = NaN; break; }
        weighted += item.shares * close;
      }
      if (Number.isFinite(weighted)) entryPriceUsd = weighted / depositedShares;
      else entryUnavailableReason = "No price was found for a deposit day.";
    }
  }

  const priceKnown = priceUsd !== null && entryPriceUsd !== null && entryPriceUsd > 0 && sharesIn !== null;
  const priceChangeUsd = priceKnown && sharesIn! > DUST_SHARES ? sharesIn! * (priceUsd! - entryPriceUsd!) : priceKnown ? 0 : null;
  const priceChangePct = priceKnown ? (priceUsd! / entryPriceUsd! - 1) * 100 : null;
  const feeUsd = priceUsd !== null ? feeShares * priceUsd : null;

  const firstDayStart = firstTime !== null ? Math.floor(firstTime / DAY) * DAY : null;
  // Past prices are cached for up to an hour: each line ends at the live price, the number its tile shows.
  const endAtLive = (values: number[]) => values.length && priceUsd !== null ? [...values, priceUsd] : values;
  const sinceEntry = endAtLive(firstDayStart !== null && input.daily ? input.daily.filter((candle) => candle.time >= firstDayStart).map((candle) => candle.close) : []);
  const last24h = endAtLive(input.hourly ? input.hourly.filter((candle) => candle.time >= input.nowSeconds - DAY).map((candle) => candle.close) : []);

  return {
    symbol: te.baseSymbol,
    priceMint: input.quote?.mint ?? null,
    priceUsd,
    change24hPct: input.quote?.priceChange24hPct ?? null,
    sharesNow,
    valueUsd: priceUsd !== null ? sharesNow * priceUsd : null,
    sharesIn,
    firstDepositAtIso: firstTime !== null ? new Date(firstTime * 1000).toISOString() : null,
    entryPriceUsd,
    priceChangeUsd,
    priceChangePct,
    feeShares,
    feeUsd,
    totalUsd: priceChangeUsd !== null && feeUsd !== null ? priceChangeUsd + feeUsd : null,
    sparkline24h: downsample(last24h),
    sparklineSinceEntry: downsample(sinceEntry),
    entryPriceSource: entryPriceUsd !== null ? input.historySource : null,
    entryUnavailableReason: entryPriceUsd !== null ? null : entryUnavailableReason ?? "The current price is unavailable.",
  };
}
