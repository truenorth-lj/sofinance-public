/** Client-safe shapes for the homepage stock cards (no server imports). */
import type { StockGainerRow, StockMarket, StockMcapRow } from "./build";
import type { StockBuyEligibility, StockBuyOption } from "./buy";

export type { StockBuyOption, StockGainerRow, StockMcapRow };

/** Rows a card shows. */
export const STOCK_CARD_ROWS = 5;

export type HomepageStocks = {
  snapshotAt: string;
  gainers: StockGainerRow[];
  stocks: StockMcapRow[];
  /** Rows with a Buy button, by underlying: only where the engine selected an issuer. */
  buy: Record<string, StockBuyOption>;
};

/**
 * What the page and `/api/stock-market` send to the browser (no allowlist internals). Each card lists the first
 * STOCK_CARD_ROWS of its ranking that can be bought, so a stock we do not support is skipped, never shown. When the
 * eligibility read failed there is nothing to filter on: the first rows are shown without Buy (fail closed).
 */
export function toHomepageStocks(market: StockMarket, eligibility: StockBuyEligibility | null): HomepageStocks {
  const pick = <Row extends { underlying: string }>(rows: Row[]) =>
    (eligibility ? rows.filter((row) => eligibility.options[row.underlying]) : rows).slice(0, STOCK_CARD_ROWS);
  return { snapshotAt: market.snapshotAt, gainers: pick(market.gainers), stocks: pick(market.stocks), buy: eligibility?.options ?? {} };
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

/** Minimum output the user confirmed, in the token's raw units: a positive integer string that fits in a u64. */
export function parseRawMinOut(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9]\d{0,19}$/.test(value)) return null;
  const raw = BigInt(value);
  return raw <= 18_446_744_073_709_551_615n ? raw : null;
}

/** A parsed JSON body that is a plain object (JSON `null`, arrays and scalars are not). */
export function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** Underlying ticker as listed (upper case letters, digits, dot), e.g. "TSLA", "BRK.B". */
export function parseUnderlying(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z0-9.]{1,12}$/.test(value) ? value : null;
}
