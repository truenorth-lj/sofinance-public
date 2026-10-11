/**
 * Estimated fee APR of a concentrated range (pure, I/O free, safe to run in the browser).
 *
 * Model ("liquidity-profile x volume-occupancy", method C in docs/rwa-range-apr.md):
 *   for every bin b of the pool inside the chosen range
 *     fees_b/day = volume_b/day * feeRate * lpFeeFraction * L_me / (L_b + L_me)
 *   APR = sum(fees_b/day) * 365 / capital * 100
 *  - volume_b: recent average daily USD volume that traded while the pool price sat inside bin b
 *    (volume outside the range earns nothing, so the in-range fraction is built in);
 *  - L_b: liquidity already in bin b (other LPs, from the on-chain tick arrays);
 *  - L_me: liquidity `capital` buys in the range at the current price.
 * It is a back-test of recent traffic against today's liquidity, not a forecast.
 */
import { liquidityForCapital } from "./clmm-liquidity";
import { sqrtPriceAtTick } from "./tick-math";

export const RANGE_APR_REFERENCE_CAPITAL_USD = 100;

export type AprBin = {
  /** Lower tick of the bin (a multiple of `tickSpacing`). */
  tick: number;
  /** Liquidity of other LPs active in this bin (raw L units). */
  liquidity: number;
  /** Average daily USD volume that traded at prices inside this bin. */
  volumeUsd: number;
};

export type RangeAprInputs = {
  tickSpacing: number;
  /** Contiguous ascending bins, `bins[i + 1].tick === bins[i].tick + tickSpacing`. */
  bins: readonly AprBin[];
  /** sqrt(raw price) of the pool right now. */
  currentSqrt: number;
  usdPerRawB: number;
  /** Trade fee as a fraction (0.0005 = 5 bps). */
  feeRate: number;
  /** Share of the trade fee LPs keep after Raydium protocol + fund cuts (0.84 on standard configs). */
  lpFeeFraction: number;
  /** Average daily USD volume over the sample window, INCLUDING volume outside the bins. */
  avgDailyVolumeUsd: number;
  capitalUsd: number;
};

export type RangeAprUnavailableReason =
  | "invalid-range" | "range-outside-window" | "no-price" | "no-capital";

export type RangeAprEstimate =
  | {
    status: "ok";
    /** Annualised fee APR in percent (simple, not compounded). */
    aprPct: number;
    /** Fraction (0-100) of recent volume that traded inside this range. */
    inRangeVolumePct: number;
    /** Estimated fees per day, USD, for `capitalUsd`. */
    feesPerDayUsd: number;
  }
  | { status: "unavailable"; reason: RangeAprUnavailableReason };

const DAYS_PER_YEAR = 365;

export function estimateRangeApr(
  inputs: RangeAprInputs,
  range: { tickLower: number; tickUpper: number },
): RangeAprEstimate {
  const { tickSpacing, bins } = inputs;
  const { tickLower, tickUpper } = range;
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper ||
    tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) {
    return { status: "unavailable", reason: "invalid-range" };
  }
  if (!(inputs.usdPerRawB > 0) || !(inputs.currentSqrt > 0)) return { status: "unavailable", reason: "no-price" };
  if (!(inputs.capitalUsd > 0)) return { status: "unavailable", reason: "no-capital" };
  const first = bins[0];
  const last = bins[bins.length - 1];
  if (!first || !last || tickLower < first.tick || tickUpper > last.tick + tickSpacing) {
    return { status: "unavailable", reason: "range-outside-window" };
  }
  const liquidity = liquidityForCapital(
    inputs.capitalUsd, inputs.currentSqrt, sqrtPriceAtTick(tickLower), sqrtPriceAtTick(tickUpper), inputs.usdPerRawB,
  );
  if (!(liquidity > 0)) return { status: "unavailable", reason: "no-capital" };

  const start = (tickLower - first.tick) / tickSpacing;
  const end = (tickUpper - first.tick) / tickSpacing;
  const lpFeeRate = inputs.feeRate * inputs.lpFeeFraction;
  let inRangeVolume = 0;
  let fees = 0;
  for (let index = start; index < end; index++) {
    const bin = bins[index]!;
    inRangeVolume += bin.volumeUsd;
    fees += bin.volumeUsd * lpFeeRate * (liquidity / (bin.liquidity + liquidity));
  }
  return {
    status: "ok",
    aprPct: (fees * DAYS_PER_YEAR / inputs.capitalUsd) * 100,
    inRangeVolumePct: inputs.avgDailyVolumeUsd > 0 ? Math.min(100, (inRangeVolume / inputs.avgDailyVolumeUsd) * 100) : 0,
    feesPerDayUsd: fees,
  };
}
