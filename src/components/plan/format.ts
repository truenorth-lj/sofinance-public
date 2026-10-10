import Decimal from "decimal.js";

const MINUS = "−";
const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function grouped(value: Decimal, places: number, trim: boolean): string {
  const fixed = trim ? value.toDecimalPlaces(places).toFixed() : value.toFixed(places);
  const [whole, fraction] = fixed.split(".");
  return fraction ? `${group(whole!)}.${fraction}` : group(whole!);
}

/** "1,000" / "2.5" — a user-chosen amount, without forced decimals. */
export function formatAmount(value: string | number): string {
  return grouped(new Decimal(value).abs(), 6, true);
}

/** "257.24" — the size of a result, to the cent, without a sign. */
export function formatCents(value: string | number): string {
  return grouped(new Decimal(value).abs(), 2, false);
}

/** "+2.65" / "−257.24" / "0" — a result, always to the cent. */
export function formatSigned(value: string | number): string {
  const amount = new Decimal(value).toDecimalPlaces(2);
  if (amount.isZero()) return "0";
  return `${amount.isNegative() ? MINUS : "+"}${grouped(amount.abs(), 2, false)}`;
}

/** "3%" / "36.5%" / "0.25%". */
export function formatPct(value: string | number, signed = false): string {
  const pct = new Decimal(value);
  const text = grouped(pct.abs(), pct.abs().lt(1) ? 2 : 1, true);
  const sign = !signed || pct.isZero() ? "" : pct.isNegative() ? MINUS : "+";
  return `${sign}${text}%`;
}

/** Compact ruler labels: 100, 1k, 10k. */
export function formatCompact(value: number): string {
  return value >= 1000 ? `${Number((value / 1000).toFixed(1))}k` : String(value);
}

const utcDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
export function formatUtcDate(iso: string | number): string {
  return utcDate.format(new Date(iso));
}
