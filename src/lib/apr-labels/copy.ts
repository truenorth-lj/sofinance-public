
/** Homepage link text for the APR docs page (homepage copy avoids the word in the docs page title). */
export const HOMEPAGE_APR_DOCS_LINK_LABEL = "How estimates work";
/** Pools table column and homepage help. Same basis as the cards: a $1,000 deposit in the best range. */
export const HIGHEST_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume and LP net fees, for a $1,000 deposit in the best range. Not a prediction. Fees not guaranteed.";

/** Card tooltip for the best range's estimate (the card prices a $1,000 deposit). */
export const CARD_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume and LP net fees, for a $1,000 deposit in this range. Not a prediction. Fees not guaranteed.";

/** Today's volume vs the 7-day daily average: a ratio above this (or below its inverse) gets a note. */
export const VOLUME_DIVERGENCE_THRESHOLD = 2;

export const volumeDivergenceSentence = (ratioText: string, direction: "hot" | "cold") =>
  `Today's volume is ${ratioText}× the 7-day average, so today's fees run ${direction} next to this 7-day estimate.`;
