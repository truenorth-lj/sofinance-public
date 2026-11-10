/** Display formats for the Performance stock view (pure). A missing number is "—", never 0. */

const MINUS = "−";
const usdFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const finite = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value);
/** Round half away from zero (Math.round sends −27.125 to −27.12). */
const round = (value: number, precision: number) => Math.sign(value) * Math.round(Math.abs(value) * precision) / precision;

/** "$1,234.56"; "−$27.13" / "+$18.37" when signed. Rounds to cents first, so −0.004 reads "$0.00", not "−$0.00". */
export function formatUsd(value: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (!finite(value)) return "—";
  const cents = round(value, 100);
  const body = `$${usdFormat.format(Math.abs(cents))}`;
  if (cents < 0) return `${MINUS}${body}`;
  return options.signed && cents > 0 ? `+${body}` : body;
}

/** "↑ 3.86%" / "↓ 5.80%" (direction only; colour is the caller's). */
export function formatChangePct(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const rounded = round(value, 100);
  return `${rounded < 0 ? "↓" : "↑"} ${Math.abs(rounded).toFixed(2)}%`;
}

/** Share counts: up to 4 decimals at 1 share or more ("2.5"), 3 significant digits below ("0.0312"). */
export function formatShares(value: number | null | undefined): string {
  if (!finite(value)) return "—";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  const text = abs >= 1 ? abs.toFixed(4).replace(/\.?0+$/, "") : Number(abs.toPrecision(3)).toString();
  return value < 0 ? `${MINUS}${text}` : text;
}

/** "Oct 20" in UTC (the day the entry price is read for). */
export function formatShortDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "up", "down" or "flat" for colouring a change (cents / hundredths of a percent). */
export function changeTone(value: number | null | undefined, precision = 100): "up" | "down" | "flat" {
  if (!finite(value)) return "flat";
  const rounded = round(value, precision);
  return rounded > 0 ? "up" : rounded < 0 ? "down" : "flat";
}
