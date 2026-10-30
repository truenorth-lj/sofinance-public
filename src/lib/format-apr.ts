/**
 * APR percent for display (shared by `/app` and the Robinhood Chain open panel):
 * missing / not a number → "—" (never "0%"), a positive value below 0.01% → "<0.01%" (instead of a misleading
 * "0.00%"), otherwise two decimals.
 */
export function formatAprPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.01) return "<0.01%";
  return `${value.toFixed(2)}%`;
}
