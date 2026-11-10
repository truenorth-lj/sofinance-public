/** Display formatting for the stock cards and the Buy modal (client-safe). */
import { formatAmount } from "@sofinance/engine/amount";

export const STOCK_NOTICE_TEXT = "Not available to US persons or restricted regions. Tokens are issued by third parties.";

export function formatStockPrice(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function formatChangePct(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

export function formatCompactUsd(value: number): string {
  if (!Number.isFinite(value)) return "–";
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];
  for (const [size, suffix] of units) if (Math.abs(value) >= size) return `$${(value / size).toFixed(1)}${suffix}`;
  return `$${value.toFixed(0)}`;
}

export const LAMPORTS_PER_SOL = 1_000_000_000;
export function formatSol(lamports: number | string | bigint): string {
  return `${formatAmount(String(lamports), 9, 6)} SOL`;
}

export function formatUsdc(raw: string): string {
  return `${formatAmount(raw, 6, 6)} USDC`;
}

export function formatTokenRaw(raw: string, decimals: number, symbol: string): string {
  return `${formatAmount(raw, decimals, Math.min(decimals, 6))} ${symbol}`;
}

/** "0.37%" from Jupiter's priceImpactPct (a fraction string, e.g. "0.0037"). */
export function formatPriceImpact(value: string | null): string {
  if (value === null) return "Unknown";
  const pct = Math.abs(Number(value)) * 100;
  if (!Number.isFinite(pct)) return "Unknown";
  return pct < 0.01 ? "<0.01%" : `${pct.toFixed(2)}%`;
}
