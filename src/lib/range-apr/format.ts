import type { RangeAprEstimate, RangeAprUnavailableReason } from "./range-apr";
import { formatApproxAprPct } from "@/lib/format/apr";

export const formatAprPct = formatApproxAprPct;

export function formatEstimate(estimate: RangeAprEstimate | null | undefined): string {
  return estimate?.status === "ok" ? formatAprPct(estimate.aprPct) : "—";
}

const REASONS: Record<RangeAprUnavailableReason, string> = {
  "invalid-range": "Enter a valid price range",
  "range-outside-window": "Range extends beyond the analysed price window",
  "no-price": "Pool price unavailable",
  "no-capital": "Pool value unavailable",
  "degraded-data": "Recent price history is temporarily unavailable, so no estimate is shown. Try again shortly",
};

export function unavailableReasonText(reason: RangeAprUnavailableReason): string {
  return REASONS[reason];
}
