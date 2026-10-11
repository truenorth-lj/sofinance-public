/** User-facing strings for the range APR estimate (shared by the modal and the pairs table). */
export const APR_ESTIMATE_LABEL = "Est. fee APR";
export const AI_PICK_APR_LABEL = "AI-pick est. APR";

/** Short caveat shown in tooltips; the long form is `assumptions` in the API payload. */
export const APR_ESTIMATE_CAVEAT =
  "Estimate, not a guarantee. Based on the last 7 complete days of pool volume and today's liquidity in each price bin. " +
  "Assumes volume and prices behave like the recent past and counts fees only while price is inside the range; " +
  "ignores impermanent loss and costs. Shown for a ~$100 deposit; larger deposits earn a lower rate. " +
  "Narrower ranges earn more per dollar but go out of range sooner.";
