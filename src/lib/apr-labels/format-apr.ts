/**
 * One APR percent for display. Missing data (null, undefined, NaN, ±Infinity) is "—", never "0.00%".
 * A real but tiny positive APR (below 0.005%, which `toFixed(2)` rounds to "0.00%") is "<0.01%", so a thin pool
 * does not read as "no data" or as exactly zero. Example: the Robinhood Chain SPCX/SPCXon pool on 2026-10-30
 * (hook fee 0.00505% × $14.76 24h volume / $48.8k TVL × 365 ≈ 0.00056%).
 */
export function formatAprPct(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "<0.01%";
  return `${value.toFixed(2)}%`;
}

/** Full-precision value for a tooltip next to a rounded APR (undefined when there is nothing to add). */
export function exactAprTitle(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0 || value >= 0.005) return undefined;
  return `≈${value.toPrecision(2)}%`;
}
