/** Display formats for the Performance stock view (pure). A missing number is "—", never 0. */

import { MINUS, finite, round } from "@/lib/format/helpers";

export { formatUsd } from "@/lib/format/usd";
export { formatArrowChangePct as formatChangePct } from "@/lib/format/pct";

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
