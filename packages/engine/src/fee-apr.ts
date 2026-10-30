/**
 * The one fee APR formula used across protocols: daily LP fees / TVL × 365, in percent (simple, no
 * compounding). Pair rows (24h fees), the daily APR history and the Robinhood Chain pool estimate all call
 * this, so a number shown in one place is computed the same way everywhere.
 */
export function feeAprPct(dailyFeesUsd: number, tvlUsd: number): number | null {
  if (!Number.isFinite(dailyFeesUsd) || !Number.isFinite(tvlUsd) || tvlUsd <= 0) return null;
  if (dailyFeesUsd < 0) return null;
  return (dailyFeesUsd / tvlUsd) * 365 * 100;
}

/** `feeAprPct` from a fee rate (0.0025 = 0.25%) and one day of USD volume; `lpFeeFraction` defaults to 1. */
export function poolFeeAprPct(input: { feeRate: number; dailyVolumeUsd: number; tvlUsd: number; lpFeeFraction?: number }): number | null {
  const { feeRate, dailyVolumeUsd } = input;
  if (!Number.isFinite(feeRate) || feeRate < 0 || !Number.isFinite(dailyVolumeUsd)) return null;
  return feeAprPct(feeRate * dailyVolumeUsd * (input.lpFeeFraction ?? 1), input.tvlUsd);
}
