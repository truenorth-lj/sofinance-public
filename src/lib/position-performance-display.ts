/** Display units only; annualization continues to use exact fractional days. */
export function formatHoldingTime(days: number | null | undefined): { label: string; value: string } {
  if (days === null || days === undefined || !Number.isFinite(days) || days <= 0) {
    return { label: "Holding time", value: "—" };
  }
  return days < 1
    ? { label: "Holding hours", value: `${(days * 24).toFixed(2)} hr` }
    : { label: "Holding days", value: `${days.toFixed(2)} days` };
}

export function returnUnavailableReason(input: {
  deposited: number | null;
  holdingDays: number | null;
  needsHoldingTime: boolean;
  missingUsdPrice: boolean;
  truncated: boolean;
}): string {
  if (input.missingUsdPrice) return "USD prices are unavailable for one or both assets.";
  if (input.deposited === null || !Number.isFinite(input.deposited) || input.deposited <= 0) {
    return input.truncated
      ? "No positive deposit amount was found in the available history. Earlier transactions may be missing."
      : "No positive deposit amount was found in the recorded transactions; a return cannot be calculated.";
  }
  if (input.needsHoldingTime && (input.holdingDays === null || !Number.isFinite(input.holdingDays) || input.holdingDays <= 0)) {
    return "A positive holding time is required; the first event time is unavailable or no time has elapsed.";
  }
  return "Required performance data is unavailable.";
}
