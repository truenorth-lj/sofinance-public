/** Labels and tooltips for the APR figures on the /app/rwa-pairs cards. Copy only; no APR math here. */
export const HIGHEST_RANGE_APR_7D_LABEL = "Est. highest range APR · 7d avg · not a prediction";
/** Homepage link text for the APR docs page (homepage copy avoids the word in the docs page title). */
export const HOMEPAGE_APR_DOCS_LINK_LABEL = "How estimates work";
export const HIGHEST_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume, LP net fees, for a $100 position in this range. Not a prediction.";

/** Today's volume vs the 7-day daily average: a ratio above this (or below its inverse) gets a note. */
export const VOLUME_DIVERGENCE_THRESHOLD = 2;

export const volumeDivergenceSentence = (ratioText: string, direction: "hot" | "cold") =>
  `Today's volume is ${ratioText}× the 7-day average, so today's fees run ${direction} next to this 7-day estimate.`;
