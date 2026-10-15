import "@/lib/engine-host";
/**
 * Where did recent volume trade? Turns hourly price candles into a share of volume per bin (pure).
 *
 * Price drift is removed before measuring (`rebase`): the pool price wanders a few ticks per day, so
 * "where did volume trade in absolute price" says little about where it will trade around the price you open
 * at. Each UTC day's path is therefore shifted so that the day's FIRST open sits at the current price: the
 * result answers "if I had opened centred on the current price at the start of each recent day, how much of
 * that day's volume would have traded inside each bin?". Without it a drifting pool shows ~0% in range for
 * narrow bands even though price keeps oscillating around wherever it is now.
 *
 * Each candle's volume is spread uniformly over the ticks between its low and high; the share that
 * lands in each pool bin is proportional to overlap. Executed trade prices carry the swap fee, which
 * makes a candle look `feeRate` wider on each side than the pool price really moved; `shrinkForFee`
 * removes that (collapsing to the midpoint when the candle is narrower than the fee noise).
 */
import { SECONDS_PER_DAY } from "../apr-series";
import type { LiquidityBin } from "./liquidity-bins";
import { exactTickFromUiPrice, sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";
import type { RawCandle } from "./gecko-candles";

/** One raw tick = 0.01% of price, so a fee of `rate` is about `rate * 10_000` ticks. */
const TICKS_PER_UNIT_RATE = 10_000;

export type TickCandle = { lowTick: number; highTick: number; weight: number };

export type TickCandleOptions = {
  decimalsA: number;
  decimalsB: number;
  feeRate: number;
  /** Fractional tick of the pool price right now. Required when `rebase` is true. */
  currentExactTick: number;
  /** Shift each UTC day so its first open sits at `currentExactTick` (default true). */
  rebase?: boolean;
  /** Remove fee-induced price noise from candle ranges (default true). */
  shrinkForFee?: boolean;
};

export function candlesToTickCandles(candles: readonly RawCandle[], options: TickCandleOptions): TickCandle[] {
  const { decimalsA, decimalsB } = options;
  const feeTicks = options.shrinkForFee === false ? 0 : options.feeRate * TICKS_PER_UNIT_RATE;
  const rebase = options.rebase !== false;
  const dayShift = new Map<number, number>();
  const out: TickCandle[] = [];
  for (const candle of [...candles].sort((left, right) => left.time - right.time)) {
    const day = Math.floor(candle.time / SECONDS_PER_DAY);
    if (rebase && !dayShift.has(day)) {
      dayShift.set(day, options.currentExactTick - exactTickFromUiPrice(candle.open, decimalsA, decimalsB));
    }
    if (!(candle.volume > 0)) continue;
    const shift = rebase ? dayShift.get(day)! : 0;
    let lowTick = exactTickFromUiPrice(candle.low, decimalsA, decimalsB) + shift;
    let highTick = exactTickFromUiPrice(candle.high, decimalsA, decimalsB) + shift;
    if (highTick - lowTick <= 2 * feeTicks) {
      const mid = (lowTick + highTick) / 2;
      lowTick = mid;
      highTick = mid;
    } else {
      lowTick += feeTicks;
      highTick -= feeTicks;
    }
    out.push({ lowTick, highTick, weight: candle.volume });
  }
  return out;
}

export type OccupancyResult = {
  /** Share of total weight per bin, aligned with the bins passed in. Sums to <= 1. */
  shares: number[];
  /** Share of weight that could not be placed: traded outside the window or in bins with no liquidity. */
  outsideShare: number;
};

/**
 * Spreads every candle's weight over the bins its price path crossed. Inside one candle the weight is split
 * in proportion to the token amount needed to cross each bin, `L_bin * (sqrtP_high - sqrtP_low)`: a swap
 * moves far more tokens through a deep bin than through a thin one, and none through an empty one. This keeps
 * volume out of bins that have no liquidity today (which a plain "uniform over price" split would fill,
 * handing a lone new LP 100% of fees there).
 */
export function binVolumeShares(
  candles: readonly TickCandle[], bins: readonly LiquidityBin[], tickSpacing: number,
): OccupancyResult | null {
  const total = candles.reduce((sum, candle) => sum + candle.weight, 0);
  const first = bins[0];
  if (!(total > 0) || !first) return null;
  const firstTick = first.tick;
  const endTick = firstTick + bins.length * tickSpacing;
  const shares = new Array<number>(bins.length).fill(0);
  let placed = 0;
  for (const candle of candles) {
    const from = Math.max(candle.lowTick, firstTick);
    const to = Math.min(candle.highTick, endTick);
    if (candle.highTick - candle.lowTick <= 0) {
      if (candle.lowTick < firstTick || candle.lowTick >= endTick) continue;
      const index = Math.floor((candle.lowTick - firstTick) / tickSpacing);
      if (bins[index]!.liquidity > 0) {
        shares[index]! += candle.weight;
        placed += candle.weight;
      }
      continue;
    }
    if (to <= from) continue;
    const firstBin = Math.floor((from - firstTick) / tickSpacing);
    const lastBin = Math.min(bins.length - 1, Math.ceil((to - firstTick) / tickSpacing) - 1);
    const crossing: number[] = [];
    let crossingTotal = 0;
    for (let index = firstBin; index <= lastBin; index++) {
      const binLow = firstTick + index * tickSpacing;
      const low = Math.max(from, binLow);
      const high = Math.min(to, binLow + tickSpacing);
      const amount = high > low ? bins[index]!.liquidity * (sqrtPriceAtTick(high) - sqrtPriceAtTick(low)) : 0;
      crossing.push(amount);
      crossingTotal += amount;
    }
    if (!(crossingTotal > 0)) continue;
    // The part of the candle's path inside the window carries the whole candle's weight only if the path
    // stayed inside; paths that leave the window keep their in-window fraction (by tokens crossed is unknown
    // outside, so use the tick-length fraction).
    const insideFraction = (to - from) / (candle.highTick - candle.lowTick);
    crossing.forEach((amount, offset) => {
      const part = candle.weight * insideFraction * (amount / crossingTotal);
      shares[firstBin + offset]! += part;
      placed += part;
    });
  }
  return {
    shares: shares.map((value) => value / total),
    outsideShare: Math.max(0, (total - placed) / total),
  };
}
