/** Labels and tooltips for the APR figures on the /app/rwa-pairs cards. Copy only; no APR math here. */
export const POOL_FEE_APR_24H_LABEL = "Est. pool fee APR · 24h · not guaranteed";
/** Short field name on the cards, also used for the 24h figure in the RHC open dialog (so it never reads as the 7d headline). */
export const POOL_FEE_APR_24H_SHORT = "Est. pool fee APR · 24h";
export const POOL_FEE_APR_24H_HELP =
  "Estimate based on the last 24h of fees ÷ TVL, annualized. Gross fee (before Raydium's 16% protocol cut). Not guaranteed.";

export const HIGHEST_RANGE_APR_7D_LABEL = "Est. highest range APR · 7d avg · not guaranteed";
/** Homepage pool list APR column: the same headline figure (and label) as the /app/rwa-pairs cards. */
export const HOMEPAGE_POOL_APR_LABEL = HIGHEST_RANGE_APR_7D_LABEL;
/** Homepage link text for the APR docs page (homepage copy avoids the word in the docs page title). */
export const HOMEPAGE_APR_DOCS_LINK_LABEL = "APR details";
export const HIGHEST_RANGE_APR_7D_HELP =
  "Estimated from the past 7 days' average volume, LP net fees, for a $100 position in this range. Not guaranteed.";

/** Today's volume vs the 7-day daily average: a ratio above this (or below its inverse) gets a note. */
export const VOLUME_DIVERGENCE_THRESHOLD = 2;

export const volumeDivergenceSentence = (ratioText: string, direction: "hot" | "cold") =>
  `Today's volume is ${ratioText}× the 7-day average, so the 24h number runs ${direction}.`;
