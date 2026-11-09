/** Client-safe shapes for the homepage stock cards (no server imports). */
import type { StockGainerRow, StockMarket, StockMcapRow } from "./build";
import type { StockBuyEligibility, StockBuyOption } from "./buy";

export type { StockBuyOption, StockGainerRow, StockMcapRow };

export type HomepageStocks = {
  snapshotAt: string;
  gainers: StockGainerRow[];
  stocks: StockMcapRow[];
  /** Price ticker rows (every listed stock, largest first); absent in snapshots written before it existed. */
  ticker?: StockMcapRow[];
  /** Rows with a Buy button, by underlying: only where the engine selected an issuer. */
  buy: Record<string, StockBuyOption>;
  /** Rows shown with a greyed "Not supported yet", by underlying: the plain reason (tooltip). */
  unsupported?: Record<string, string>;
};

/** What the page and `/api/stock-market` send to the browser (no allowlist internals). */
export function toHomepageStocks(market: StockMarket, eligibility: StockBuyEligibility | null): HomepageStocks {
  return { snapshotAt: market.snapshotAt, gainers: market.gainers, stocks: market.stocks, ticker: market.ticker, buy: eligibility?.options ?? {}, unsupported: eligibility?.unsupported ?? {} };
}

/** USDC amount typed by the user: digits, optional dot, at most 6 decimals, above zero, at most 1,000,000. */
export const SPOT_SWAP_MAX_USDC = 1_000_000;
export function parseSpotSwapAmount(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{1,7}(\.\d{1,6})?$/.test(trimmed)) return null;
  const number = Number(trimmed);
  return number > 0 && number <= SPOT_SWAP_MAX_USDC ? trimmed : null;
}

/** Underlying ticker as listed (upper case letters, digits, dot), e.g. "TSLA", "BRK.B". */
export function parseUnderlying(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9.]{1,12}$/.test(value) ? value : null;
}
