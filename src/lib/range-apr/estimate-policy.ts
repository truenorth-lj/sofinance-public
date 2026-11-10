import { capAprAtPoolFees } from "@/lib/lp-plan-pool-terms";
import type { RangeAprEstimate } from "./range-apr";
import type { PoolRangeAprPayload } from "./types";

/** The whole pool's observed LP fees, not its average APR or a TVL allocation. */
export function poolLpFeesPerDayUsd(payload: PoolRangeAprPayload): number | null {
  const volume = payload.model?.avgDailyVolumeUsd, fee = payload.pool.feeRate, share = payload.pool.lpFeeFraction;
  const values = [volume, fee, share];
  return values.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    ? volume * fee * share : null;
}

/** Every displayed estimate is bounded by all fees the pool paid, at the estimate's own capital. */
export function capRangeEstimate(payload: PoolRangeAprPayload, estimate: RangeAprEstimate): RangeAprEstimate {
  if (estimate.status !== "ok") return estimate;
  const aprPct = capAprAtPoolFees(estimate.aprPct, {
    poolLpFeesPerDayUsd: poolLpFeesPerDayUsd(payload), poolTvlUsd: 0, depositUsd: payload.referenceCapitalUsd,
  });
  if (aprPct === estimate.aprPct) return estimate;
  return { ...estimate, aprPct, feesPerDayUsd: Math.min(estimate.feesPerDayUsd, aprPct / 100 * payload.referenceCapitalUsd / 365) };
}
