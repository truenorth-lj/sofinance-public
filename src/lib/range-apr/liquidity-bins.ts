/**
 * Rebuilds the pool's per-bin liquidity profile from the pool's active liquidity and the
 * `liquidityNet` of initialised ticks (pure; the on-chain reads live in `pool-range-apr.ts`).
 *
 * Uniswap-v3 style bookkeeping: crossing an initialised tick upward adds its `liquidityNet`,
 * crossing it downward subtracts it. The bin that contains `tickCurrent` has exactly `poolLiquidity`.
 */
import { binIndexOfTick } from "./tick-math";

/** Ticks per Raydium tick array account: it holds 60 ticks, `tickSpacing` apart. */
export const TICK_ARRAY_SIZE = 60;

export type LiquidityBin = { tick: number; liquidity: number };

export function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  return Math.floor(tick / span) * span + 0;
}

/** Start indexes of every tick array that overlaps `[lowTick, highTick]`. */
export function tickArrayStartsForWindow(lowTick: number, highTick: number, tickSpacing: number): number[] {
  const span = TICK_ARRAY_SIZE * tickSpacing;
  const starts: number[] = [];
  for (let start = tickArrayStartIndex(lowTick, tickSpacing); start <= highTick; start += span) starts.push(start);
  return starts;
}

/** The bins analysed around the current price: `halfWindowBins` on each side of the current bin. */
export function windowBounds(tickCurrent: number, tickSpacing: number, halfWindowBins: number) {
  const currentBin = binIndexOfTick(tickCurrent, tickSpacing);
  return {
    currentBin,
    firstTick: (currentBin - halfWindowBins) * tickSpacing,
    /** Exclusive upper end of the window. */
    endTick: (currentBin + halfWindowBins + 1) * tickSpacing,
  };
}

export function buildLiquidityBins(input: {
  tickCurrent: number;
  tickSpacing: number;
  poolLiquidity: bigint;
  /** liquidityNet by tick index, only for initialised ticks inside the window. */
  liquidityNet: ReadonlyMap<number, bigint>;
  halfWindowBins: number;
}): LiquidityBin[] {
  const { tickSpacing, halfWindowBins } = input;
  const { currentBin } = windowBounds(input.tickCurrent, tickSpacing, halfWindowBins);
  const levels = new Map<number, bigint>([[currentBin, input.poolLiquidity]]);
  let liquidity = input.poolLiquidity;
  for (let bin = currentBin + 1; bin <= currentBin + halfWindowBins; bin++) {
    liquidity += input.liquidityNet.get(bin * tickSpacing) ?? 0n;
    levels.set(bin, liquidity < 0n ? 0n : liquidity);
  }
  liquidity = input.poolLiquidity;
  for (let bin = currentBin; bin > currentBin - halfWindowBins; bin--) {
    liquidity -= input.liquidityNet.get(bin * tickSpacing) ?? 0n;
    levels.set(bin - 1, liquidity < 0n ? 0n : liquidity);
  }
  const bins: LiquidityBin[] = [];
  for (let bin = currentBin - halfWindowBins; bin <= currentBin + halfWindowBins; bin++) {
    bins.push({ tick: bin * tickSpacing, liquidity: Number(levels.get(bin)!) });
  }
  return bins;
}
