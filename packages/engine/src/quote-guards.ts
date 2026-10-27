// Jupiter reports this as a decimal fraction (0.01 means 1%). Forward routes
// also use a small-amount probe; reverse routes feed the resale-floor check.
export function acceptableReportedPriceImpact(value: unknown, maxBps: number) {
  if (value === undefined) return true;
  if (typeof value !== "string" && typeof value !== "number") return false;
  const impact = Number(value);
  return Number.isFinite(impact) && impact >= 0 && impact * 10_000 <= maxBps;
}
