import { MISSING } from "./helpers";

/**
 * One APR percent for display, always two decimals. Missing data is "—", never "0.00%".
 * A real but tiny positive APR (below 0.005%, which `toFixed(2)` rounds to "0.00%") is "<0.01%".
 */
export function formatAprPct2dp(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return MISSING;
  if (value > 0 && value < 0.005) return "<0.01%";
  return `${value.toFixed(2)}%`;
}

/** Full-precision value for a tooltip next to a rounded APR (undefined when there is nothing to add). */
export function exactAprTitle(value: number | null | undefined): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value === 0 || value >= 0.005) return undefined;
  return `≈${value.toPrecision(2)}%`;
}

/**
 * "~12.3%", "~154%", "1,000%+"; one decimal below 10, none above, capped so absurd values stay readable.
 * `approx: false` drops the "~" for headline figures whose label already says they are estimates.
 */
export function formatApproxAprPct(aprPct: number, approx = true): string {
  if (!Number.isFinite(aprPct) || aprPct < 0) return MISSING;
  if (aprPct >= 1000) return "1,000%+";
  const mark = approx ? "~" : "";
  if (aprPct < 0.05) return `${mark}0%`;
  return `${mark}${aprPct < 10 ? aprPct.toFixed(1) : aprPct.toFixed(0)}%`;
}

/** Chart tick / tooltip APR: two decimals below 100, one decimal at 100 and above. */
export function formatChartAprPct(value: number): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  return `${value.toFixed(digits)}%`;
}
