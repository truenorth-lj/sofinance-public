import { HOMEPAGE_MIN_TVL_USD } from "./homepage-pools";
import { isThinPlanSample, PLAN_MIN_RELIABLE_SAMPLE_DAYS } from "./lp-plan-yield";

/** Pools below this TVL get the small-pool warning in the calculator: the same $5k floor the homepage list uses. */
export const PLAN_SMALL_POOL_TVL_USD = HOMEPAGE_MIN_TVL_USD;

/**
 * What the share calculator says about the data behind a projection:
 * - `hide`: fewer than `PLAN_MIN_RELIABLE_SAMPLE_DAYS` days of trading data. A few days (often a pool's launch) can
 *   average to thousands of percent, so no numbers are shown at all.
 * - `warn`: enough days, but a pool under `PLAN_SMALL_POOL_TVL_USD`. The numbers are shown, capped at the pool's real
 *   fees and split with the deposit, with a plain warning that they swing a lot.
 * - null: nothing to say.
 */
/**
 * The one line kept under the calculator when its numbers are hidden (`hide`): the "Best case … compounded daily"
 * footnote describes numbers that are not there, so only the risk is stated.
 */
export const PLAN_HIDDEN_RISK_LINE = "Fees are not promised: a pool can pay less than before, or nothing.";

export type PlanDataNotice = { kind: "hide" | "warn"; message: string } | null;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function planDataNotice(input: { sampleDays: number; poolTvlUsd: number | null | undefined }): PlanDataNotice {
  const { sampleDays, poolTvlUsd } = input;
  if (isThinPlanSample(sampleDays)) {
    const days = `${sampleDays} ${sampleDays === 1 ? "day" : "days"}`;
    return {
      kind: "hide",
      message: `Only ${days} of trading data for this pool, too few to project fees from, so no numbers are shown. ` +
        `Check back once it has ${PLAN_MIN_RELIABLE_SAMPLE_DAYS} days.`,
    };
  }
  if (poolTvlUsd !== null && poolTvlUsd !== undefined && Number.isFinite(poolTvlUsd) && poolTvlUsd < PLAN_SMALL_POOL_TVL_USD) {
    return {
      kind: "warn",
      message: `Small pool: about ${usd.format(poolTvlUsd)} in it. These numbers are capped at the fees this pool actually ` +
        "paid, shared with your deposit. With so little in the pool, a few trades can swing them a lot.",
    };
  }
  return null;
}
