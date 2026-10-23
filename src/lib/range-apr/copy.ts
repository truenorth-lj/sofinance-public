/** User-facing strings for the range APR estimate (shared by the modal and the pair cards). */
export const APR_ESTIMATE_LABEL = "Est. fee APR · not guaranteed";
export const BEST_LABEL = "Best";
/** Shown next to a candidate whose deposit does not fit, so a higher APR is not mistaken for a better pick. */
export const DOES_NOT_FIT_SIZE_LABEL = "doesn't fit this size";
export const HIGHEST_RANGE_COLUMN_LABEL = "Highest range";
export const HIGHEST_RANGE_APR_LABEL = "Est. highest range APR";

/** Short caveat shown in tooltips; the long form is `assumptions` in the API payload. */
export const APR_ESTIMATE_CAVEAT =
  "Estimate, not a guarantee. Based on the last 7 complete days of pool volume and today's liquidity in each price bin. " +
  "Assumes volume and prices behave like the recent past and counts fees only while price is inside the range; " +
  "ignores impermanent loss and costs. Sized to the amount you enter (~$100 until you enter one); larger deposits " +
  "dilute their own share of fees, so the rate drops. Narrower ranges collect more fees per dollar but go out of range sooner.";

/** "Best": the candidate with the highest estimated fee APR; a ranking of an estimate, not a prediction. */
export const BEST_HELP =
  "The range with the highest estimated fee APR over the last 7 days for this pool " +
  "(Micro, Tight, Standard or Wide; ties go to the wider range), for the amount you enter. Ranges are skipped when " +
  "your deposit would be over half of the pool's active liquidity, the nearer edge is within about three times the " +
  "estimated price impact, or the estimated swap would leave the current tick-spacing band (prepare cannot size that); " +
  "if none fit, the widest range is suggested. Not a prediction. " +
  "A higher APR usually means a narrower range and a higher risk of leaving range.";

export const HIGHEST_RANGE_HELP =
  "The candidate range (Micro, Tight, Standard or Wide) with the highest estimated fee APR for this pool, from the last 7 days of data; " +
  "ties go to the wider range. A higher APR usually means a higher risk of leaving range.";
