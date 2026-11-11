/**
 * Pure builder for the homepage Top Gainers / Top Stocks cards (PM data pack, sofi_home_v2/data/README.md).
 *
 * Input: the fixed universe (`universe.ts`) and the rows Jupiter Tokens V2 search returned for those mints.
 * Rules, for both cards:
 *   - match by exact mint (a row whose `id` is not a requested universe mint is ignored; symbols are never used);
 *   - Jupiter `isVerified` and a "stocks" or "equities" tag; never tSpaceX, BP or a pump.fun look-alike;
 *   - market cap >= $1M, Jupiter liquidity >= $50k, 24h volume (buy + sell) >= $10k.
 * Top Gainers: tokens ranked by Jupiter 24h price change, one row per stock (its best-performing token).
 * Top Stocks: Solana-only market cap (Jupiter `mcap` = circulating Solana supply x price), summed per stock over
 * the tokens that pass the filters; the row shows its primary token (xStocks when it passes, else the largest).
 * Each list keeps every stock that passes the filters, in rank order; a card shows the first STOCK_CARD_ROWS of them
 * that can be bought (`toHomepageStocks`), so a stock we do not support is skipped instead of shown greyed out. The
 * whole ranking is kept because unsupported stocks cluster at the top: on 2026-11-09, 11 of the 26 listed stocks failed
 * the mint check (ScaledUiAmount multiplier not 1, e.g. NVDA, AAPL, MSFT, SPY), and Top Stocks reached its 5th
 * buyable stock at rank 11.
 */
import { STOCK_CARD_ROWS } from "./public";
import { STOCK_EXCLUDED_MINTS, STOCK_UNIVERSE, type StockIssuer, type StockUniverseRow } from "./universe";

const STOCK_MIN_MCAP_USD = 1_000_000;
const STOCK_MIN_LIQUIDITY_USD = 50_000;
const STOCK_MIN_VOLUME_24H_USD = 10_000;
export { STOCK_CARD_ROWS };

/** The fields we read from one Jupiter Tokens V2 search row. */
export type JupiterStockRow = {
  id: string; name: string | null; symbol: string | null; icon: string | null; isVerified: boolean; tags: string[];
  usdPrice: number | null; mcap: number | null; liquidity: number | null; priceChange24h: number | null; volume24h: number | null;
};

/** One universe token with its Jupiter market data (only tokens that pass every filter). */
export type StockToken = {
  mint: string; symbol: string; underlying: string; issuer: StockIssuer; company: string;
  /** Jupiter metadata the spot-swap engine needs for non-xStocks issuers (verified tag + name). */
  jupiterName: string | null; jupiterTags: string[]; xstocks: boolean;
  icon: string | null; priceUsd: number; change24hPct: number; mcapUsd: number; liquidityUsd: number; volume24hUsd: number;
};

export type StockGainerRow = { underlying: string; company: string; mint: string; symbol: string; icon: string | null; priceUsd: number; change24hPct: number };
export type StockMcapRow = StockGainerRow & { mcapUsd: number };

export type StockMarket = {
  /** ISO time of the Jupiter read. */
  snapshotAt: string;
  /** Every listed stock, ranked; the card shows the first STOCK_CARD_ROWS that can be bought. */
  gainers: StockGainerRow[];
  stocks: StockMcapRow[];
  /** Every token that passed the filters, by stock (allowlist source for Buy; xStocks first). */
  tokensByUnderlying: Record<string, StockToken[]>;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/** Parse one raw search row; null when it is not an object with a string `id`. */
export function parseJupiterStockRow(raw: unknown): JupiterStockRow | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const id = str(row.id);
  if (!id) return null;
  const stats = row.stats24h && typeof row.stats24h === "object" ? row.stats24h as Record<string, unknown> : {};
  const buy = num(stats.buyVolume), sell = num(stats.sellVolume);
  return {
    id, name: str(row.name), symbol: str(row.symbol), icon: str(row.icon), isVerified: row.isVerified === true,
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    usdPrice: num(row.usdPrice), mcap: num(row.mcap), liquidity: num(row.liquidity), priceChange24h: num(stats.priceChange),
    volume24h: buy === null && sell === null ? null : (buy ?? 0) + (sell ?? 0),
  };
}

/** A pump.fun mint (vanity suffix) or an explicitly excluded one: never listed. */
export function isExcludedStockMint(mint: string): boolean {
  return STOCK_EXCLUDED_MINTS.has(mint) || mint.endsWith("pump");
}

const ISSUER_ORDER: Record<StockIssuer, number> = { xstocks: 0, backpack: 1, ondo: 2 };

/** Why a universe token is not listed (null = listed). Exported for tests and the cross-check script. */
export function stockTokenRejection(row: JupiterStockRow | undefined): string | null {
  if (!row) return "missing";
  if (isExcludedStockMint(row.id)) return "excluded";
  if (!row.isVerified) return "unverified";
  if (!row.tags.includes("stocks") && !row.tags.includes("equities")) return "not_stock";
  if (row.usdPrice === null || row.usdPrice <= 0 || row.priceChange24h === null) return "no_price";
  if ((row.mcap ?? 0) < STOCK_MIN_MCAP_USD) return "mcap";
  if ((row.liquidity ?? 0) < STOCK_MIN_LIQUIDITY_USD) return "liquidity";
  if ((row.volume24h ?? 0) < STOCK_MIN_VOLUME_24H_USD) return "volume";
  return null;
}

export function buildStockMarket(rows: readonly JupiterStockRow[], options: {
  now?: Date; universe?: readonly StockUniverseRow[]; icon?: (raw: string | null) => string | null; limit?: number;
} = {}): StockMarket {
  const universe = options.universe ?? STOCK_UNIVERSE;
  const icon = options.icon ?? (() => null);
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const byMint = new Map<string, JupiterStockRow>();
  for (const row of rows) if (!byMint.has(row.id)) byMint.set(row.id, row);

  const tokens: StockToken[] = [];
  for (const [mint, symbol, underlying, issuer, company] of universe) {
    const row = byMint.get(mint);
    if (stockTokenRejection(row) !== null || !row) continue;
    tokens.push({
      mint, symbol, underlying, issuer, company,
      jupiterName: row.name, jupiterTags: row.tags,
      // Preferred issuer only when both our registry and Jupiter say xStocks.
      xstocks: issuer === "xstocks" && row.tags.includes("xstocks"),
      icon: icon(row.icon), priceUsd: row.usdPrice!, change24hPct: row.priceChange24h!,
      mcapUsd: row.mcap!, liquidityUsd: row.liquidity!, volume24hUsd: row.volume24h!,
    });
  }

  const tokensByUnderlying: Record<string, StockToken[]> = {};
  for (const token of tokens) (tokensByUnderlying[token.underlying] ??= []).push(token);
  for (const list of Object.values(tokensByUnderlying)) list.sort((a, b) => ISSUER_ORDER[a.issuer] - ISSUER_ORDER[b.issuer] || b.mcapUsd - a.mcapUsd);

  const row = (token: StockToken): StockGainerRow => ({ underlying: token.underlying, company: token.company, mint: token.mint,
    symbol: token.symbol, icon: token.icon, priceUsd: token.priceUsd, change24hPct: token.change24hPct });

  const bestGain = new Map<string, StockToken>();
  for (const token of tokens) {
    const best = bestGain.get(token.underlying);
    if (!best || token.change24hPct > best.change24hPct) bestGain.set(token.underlying, token);
  }
  const gainers = [...bestGain.values()].sort((a, b) => b.change24hPct - a.change24hPct || a.underlying.localeCompare(b.underlying))
    .slice(0, limit).map(row);

  const stocks = Object.entries(tokensByUnderlying).map(([, list]) => {
    const primary = list.find((token) => token.xstocks) ?? [...list].sort((a, b) => b.mcapUsd - a.mcapUsd)[0]!;
    return { ...row(primary), mcapUsd: list.reduce((sum, token) => sum + token.mcapUsd, 0) };
  }).sort((a, b) => b.mcapUsd - a.mcapUsd || a.underlying.localeCompare(b.underlying)).slice(0, limit);

  return { snapshotAt: (options.now ?? new Date()).toISOString(), gainers, stocks, tokensByUnderlying };
}

/** Each card's ranked candidates (underlyings, best first): what Buy eligibility walks to fill the cards. */
export function cardRankings(market: Pick<StockMarket, "gainers" | "stocks">): string[][] {
  return [market.gainers.map((row) => row.underlying), market.stocks.map((row) => row.underlying)];
}
