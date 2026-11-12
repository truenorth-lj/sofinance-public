import { MISSING, MINUS, finite, round } from "./helpers";

const usdFormat = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$1,234.56"; "−$27.13" / "+$18.37" when signed. Rounds to cents first, so −0.004 reads "$0.00", not "−$0.00". */
export function formatUsd(value: number | null | undefined, options: { signed?: boolean } = {}): string {
  if (!finite(value)) return MISSING;
  const cents = round(value, 100);
  const body = `$${usdFormat.format(Math.abs(cents))}`;
  if (cents < 0) return `${MINUS}${body}`;
  return options.signed && cents > 0 ? `+${body}` : body;
}

/** Stock card price: 2 decimals at $1+, 4 from $0.01, 6 below. */
export function formatStockPrice(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** Compact market-cap style: $1.5T / $1.5B / $1.5M / $1.5k, otherwise whole dollars. */
export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) if (Math.abs(value) >= size) return `$${(value / size).toFixed(1)}${suffix}`;
  return `$${value.toFixed(0)}`;
}

/** Pool TVL / 24h volume on the pool list: $1.50M / $1.5k / $12.34. */
export function formatPoolUsd(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return MISSING;
  if (Math.abs(value) >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `$${(value / 1_000).toFixed(1)}k`;
  return `$${value.toFixed(2)}`;
}

/** Position performance USD figures, four decimals. */
export function formatUsd4dp(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `$${value.toFixed(4)}`;
}
