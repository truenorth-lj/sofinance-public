import type { RangeAprEstimate, RangeAprUnavailableReason } from "./range-apr";

/**
 * "~12.3%", "~154%", "1,000%+"; one decimal below 10, none above, capped so absurd values stay readable.
 * `approx: false` drops the "~" for headline figures whose label already says they are estimates.
 */
export function formatAprPct(aprPct: number, approx = true): string {
  if (!Number.isFinite(aprPct) || aprPct < 0) return "—";
  if (aprPct >= 1000) return "1,000%+";
  const mark = approx ? "~" : "";
  if (aprPct < 0.05) return `${mark}0%`;
  return `${mark}${aprPct < 10 ? aprPct.toFixed(1) : aprPct.toFixed(0)}%`;
}

export function formatEstimate(estimate: RangeAprEstimate | null | undefined): string {
  return estimate?.status === "ok" ? formatAprPct(estimate.aprPct) : "—";
}

const REASONS: Record<RangeAprUnavailableReason, string> = {
  "invalid-range": "Enter a valid price range",
  "range-outside-window": "Range extends beyond the analysed price window",
  "no-price": "Pool price unavailable",
  "no-capital": "Pool value unavailable",
};

export function unavailableReasonText(reason: RangeAprUnavailableReason): string {
  return REASONS[reason];
}
