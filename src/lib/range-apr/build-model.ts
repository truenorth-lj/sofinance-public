/**
 * Assembles the browser-ready APR model from already-fetched pieces (pure; the fetching is in
 * `pool-range-apr.ts`).
 */
import type { AprBin } from "./range-apr";
import type { LiquidityBin } from "./liquidity-bins";
import type { OccupancyResult } from "./occupancy";
import type { OccupancySource, SampleConfidence, VolumeSource } from "./types";

export function buildAprBins(
  liquidity: readonly LiquidityBin[],
  occupancy: OccupancyResult | null,
  avgDailyVolumeUsd: number,
  currentTick: number,
  tickSpacing: number,
): AprBin[] {
  const currentBinTick = Math.floor(currentTick / tickSpacing) * tickSpacing;
  return liquidity.map((bin, index) => ({
    tick: bin.tick,
    liquidity: bin.liquidity,
    // Without price history, all volume is assumed to trade at the current price.
    volumeUsd: occupancy
      ? avgDailyVolumeUsd * occupancy.shares[index]!
      : bin.tick === currentBinTick ? avgDailyVolumeUsd : 0,
  }));
}

/** USD per one raw unit of token B, derived from Raydium's TVL and the pool's token amounts. */
export function usdPerRawTokenB(input: {
  tvlUsd: number; mintAmountA: number; mintAmountB: number; priceBPerA: number; decimalsB: number;
}): number | null {
  const valueInB = input.mintAmountA * input.priceBPerA + input.mintAmountB;
  if (!(input.tvlUsd > 0) || !(valueInB > 0)) return null;
  return input.tvlUsd / valueInB / Math.pow(10, input.decimalsB);
}

/** Share of the trade fee that LPs keep: 1 - (protocol + fund) fee rates (parts per million). */
export function lpFeeFraction(protocolFeeRate: number | null, fundFeeRate: number | null): number {
  const cut = (protocolFeeRate ?? 120_000) + (fundFeeRate ?? 40_000);
  return Math.min(1, Math.max(0, 1 - cut / 1_000_000));
}

/** Fewer complete days than this, or this much unplaced volume, marks the estimate as low confidence. */
export const LOW_CONFIDENCE_MIN_DAYS = 3;
export const LOW_CONFIDENCE_MAX_UNPLACED_PCT = 30;

export function sampleConfidence(sample: {
  days: number; volumeSource: VolumeSource; occupancySource: OccupancySource; unplacedVolumePct: number;
}): SampleConfidence {
  return sample.days < LOW_CONFIDENCE_MIN_DAYS || sample.volumeSource !== "geckoterminal-daily" ||
    sample.occupancySource !== "hourly-candles" || sample.unplacedVolumePct > LOW_CONFIDENCE_MAX_UNPLACED_PCT
    ? "low" : "ok";
}
