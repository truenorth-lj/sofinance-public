import { HOMEPAGE_MIN_TVL_USD } from "./homepage-pools";
import { isThinPlanSample } from "./lp-plan-yield";
import { dataDaysLabel, isShortAprWindow } from "./min-data-days";

/** Pools below this TVL get the small-pool warning in the calculator: the same $5k floor the homepage list uses. */
const PLAN_SMALL_POOL_TVL_USD = HOMEPAGE_MIN_TVL_USD;

/**
 * What the share calculator says about the data behind a projection:
 * - `hide`: fewer than `MIN_APR_DATA_DAYS` complete UTC day of trading data, so no numbers are shown.
 * - `warn`: at least one complete day, but a pool under `PLAN_SMALL_POOL_TVL_USD`. The numbers are shown, capped at the
 *   pool's real fees and split with the deposit, with a plain warning that they swing a lot.
 * - `info`: a window shorter than 7 days (and not a small-pool warning). The numbers are shown, labelled with the day count.
 * - null: nothing to say.
 */
/**
 * The one line kept under the calculator when its numbers are hidden (`hide`): the "Best case … compounded daily"
 * footnote describes numbers that are not there, so only the risk is stated.
 */
export const PLAN_HIDDEN_RISK_LINE = "Fees not guaranteed. A pool can pay less than before, or nothing.";

export type PlanDataNotice = { kind: "hide" | "warn" | "info"; message: string } | null;

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function planDataNotice(input: { sampleDays: number; poolTvlUsd: number | null | undefined }): PlanDataNotice {
  const { sampleDays, poolTvlUsd } = input;
  if (isThinPlanSample(sampleDays)) {
    return { kind: "hide", message: "No complete day of trading data yet, so no numbers are shown." };
  }
  const short = isShortAprWindow(sampleDays) ? `Based on ${dataDaysLabel(sampleDays)}.` : null;
  if (poolTvlUsd !== null && poolTvlUsd !== undefined && Number.isFinite(poolTvlUsd) && poolTvlUsd < PLAN_SMALL_POOL_TVL_USD) {
    return {
      kind: "warn",
      message: [short, `Small pool: about ${usd.format(poolTvlUsd)} in it. These numbers are capped at the fees this pool actually ` +
        "paid, shared with your deposit. With so little in the pool, a few trades can swing them a lot."].filter(Boolean).join(" "),
    };
  }
  if (short) return { kind: "info", message: short };
  return null;
}
