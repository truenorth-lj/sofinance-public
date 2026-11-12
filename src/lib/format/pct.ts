import { MISSING, MINUS, finite, round } from "./helpers";

/** "+3.86%" / "−5.80%" / "0.00%" (signed; colour is the caller's). */
export function formatSignedChangePct(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const sign = value > 0 ? "+" : value < 0 ? MINUS : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/** "↑ 3.86%" / "↓ 5.80%" (direction only; colour is the caller's). */
export function formatArrowChangePct(value: number | null | undefined): string {
  if (!finite(value)) return MISSING;
  const rounded = round(value, 100);
  return `${rounded < 0 ? "↓" : "↑"} ${Math.abs(rounded).toFixed(2)}%`;
}

/** Two-decimal percent with a missing glyph, no tiny-value substitution. */
export function formatPct2dp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${value.toFixed(2)}%`;
}
