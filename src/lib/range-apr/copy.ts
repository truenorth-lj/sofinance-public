/** User-facing strings for the range APR estimate (shared by the modal and the pairs table). */
export const APR_ESTIMATE_LABEL = "Est. fee APR";
export const AI_BEST_LABEL = "AI best";
export const HIGHEST_RANGE_COLUMN_LABEL = "Highest range";

/** Short caveat shown in tooltips; the long form is `assumptions` in the API payload. */
export const APR_ESTIMATE_CAVEAT =
  "Estimate, not a guarantee. Based on the last 7 complete days of pool volume and today's liquidity in each price bin. " +
  "Assumes volume and prices behave like the recent past and counts fees only while price is inside the range; " +
  "ignores impermanent loss and costs. Shown for a ~$100 deposit; larger deposits earn a lower rate. " +
  "Narrower ranges earn more per dollar but go out of range sooner.";

/** Honest description of "AI best": an automatic pick by a fixed rule, not a model and not a prediction. */
export const AI_BEST_HELP =
  "Picked automatically as the range with the highest estimated fee APR for this pool from the last 7 days of data " +
  "(Micro, Tight, Standard or Wide; ties go to the wider range). It is not a prediction and not an AI model. " +
  "A higher APR usually means a narrower range and a higher risk of leaving range.";

export const HIGHEST_RANGE_HELP =
  "The candidate range (Micro, Tight, Standard or Wide) with the highest estimated fee APR for this pool, from the last 7 days of data; " +
  "ties go to the wider range. A higher APR usually means a higher risk of leaving range.";
