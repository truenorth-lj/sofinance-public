/** Labels and tooltips for the APR figures on the /app/rwa-pairs cards. Copy only; no APR math here. */
export const HIGHEST_RANGE_APR_7D_LABEL = "Est. highest range APR · 7d avg · not a prediction";
/** Homepage link text for the APR docs page (homepage copy avoids the word in the docs page title). */
export const HOMEPAGE_APR_DOCS_LINK_LABEL = "How estimates work";
/**
 * Pools table column and homepage help: one line for every row, capped or not (the card says which, see
 * `CARD_POOL_AVG_APR_7D_HELP`). Same basis as the cards: a $1,000 deposit, held to the pool's own average fee rate.
 */
export const HIGHEST_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume and LP net fees, for a $1,000 deposit in the best range, capped at the pool's average fee rate where that is lower. Not a prediction. Fees not guaranteed.";

/** Card label when the pool-fee cap sets the number: the pool's average, no range name. */
export const POOL_AVG_APR_7D_LABEL = "Pool avg APR · 7d";
/** Card tooltip for a range estimate the cap left alone (the card prices a $1,000 deposit). */
export const CARD_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume and LP net fees, for a $1,000 deposit in this range. Not a prediction. Fees not guaranteed.";
/** Card tooltip when the cap lowered the range estimate to the pool's average. */
export const CARD_POOL_AVG_APR_7D_HELP =
  "Estimated for a $1,000 deposit and capped at the pool's average fee rate over the past 7 days, which is lower than the best range estimate here. Not a prediction. Fees not guaranteed.";

/** Today's volume vs the 7-day daily average: a ratio above this (or below its inverse) gets a note. */
export const VOLUME_DIVERGENCE_THRESHOLD = 2;

export const volumeDivergenceSentence = (ratioText: string, direction: "hot" | "cold") =>
  `Today's volume is ${ratioText}× the 7-day average, so today's fees run ${direction} next to this 7-day estimate.`;
