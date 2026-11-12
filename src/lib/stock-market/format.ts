/** Display formatting for the stock cards and the Buy modal (client-safe). */
import { formatAmount } from "@sofinance/engine/amount";

export { formatCompactUsd, formatStockPrice } from "@/lib/format/usd";
export { formatSignedChangePct as formatChangePct } from "@/lib/format/pct";

export const STOCK_NOTICE_TEXT = "Not available to US persons or restricted regions. Tokens are issued by third parties.";

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
