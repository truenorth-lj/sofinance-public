/**
 * All-stocks overview of the Performance tab (pure): positions' stock views grouped by stock, and the totals across
 * stocks. One row per stock: several positions of the same stock add up (shares, USD) and their entry prices average
 * by the shares put in. Across stocks only USD adds up; the 24h line is each stock's value change over 24h, summed.
 * A missing input makes the sum it feeds "unknown" (null), never a partial number.
 */
import type { StockPerformance } from "./position-performance-report";

export type StockRow = StockPerformance & { positionKeys: string[] };

export type PortfolioTotals = {
  stocks: number;
  valueUsd: number | null;
  /** Value now minus value 24h ago at the same share counts: Σ value × c / (100 + c). */
  change24hUsd: number | null;
  change24hPct: number | null;
  priceChangeUsd: number | null;
  /** Σ shares put in × entry price. */
  costUsd: number | null;
  priceChangePct: number | null;
  feeUsd: number | null;
  totalUsd: number | null;
};

const sumOrNull = (values: Array<number | null>): number | null =>
  values.some((value) => value === null) ? null : values.reduce<number>((sum, value) => sum + value!, 0);

/** Same-symbol positions as one row, in first-seen order. */
export function groupByStock(items: ReadonlyArray<{ key: string; stock: StockPerformance }>): StockRow[] {
  const groups = new Map<string, Array<{ key: string; stock: StockPerformance }>>();
  for (const item of items) {
    const list = groups.get(item.stock.symbol) ?? [];
    list.push(item);
    groups.set(item.stock.symbol, list);
  }
  return [...groups.values()].map((list) => {
    if (list.length === 1) return { ...list[0]!.stock, positionKeys: [list[0]!.key] };
    const stocks = list.map((item) => item.stock);
    // The share price and its sparklines come from the largest position (the same stock may be priced off either token).
    const lead = [...stocks].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0))[0]!;
    const earliest = [...stocks].filter((stock) => stock.firstDepositAtIso)
      .sort((a, b) => a.firstDepositAtIso!.localeCompare(b.firstDepositAtIso!))[0] ?? null;
    const sharesIn = sumOrNull(stocks.map((stock) => stock.sharesIn));
    const cost = sumOrNull(stocks.map((stock) => stock.sharesIn !== null && stock.entryPriceUsd !== null ? stock.sharesIn * stock.entryPriceUsd : null));
    const priceChangeUsd = sumOrNull(stocks.map((stock) => stock.priceChangeUsd));
    const feeUsd = sumOrNull(stocks.map((stock) => stock.feeUsd));
    return {
      ...lead,
      sharesNow: stocks.reduce((sum, stock) => sum + stock.sharesNow, 0),
      valueUsd: sumOrNull(stocks.map((stock) => stock.valueUsd)),
      sharesIn,
      firstDepositAtIso: earliest?.firstDepositAtIso ?? null,
      entryPriceUsd: cost !== null && sharesIn ? cost / sharesIn : null,
      priceChangeUsd,
      priceChangePct: priceChangeUsd !== null && cost ? priceChangeUsd / cost * 100 : null,
      feeShares: stocks.reduce((sum, stock) => sum + stock.feeShares, 0),
      feeUsd,
      totalUsd: priceChangeUsd !== null && feeUsd !== null ? priceChangeUsd + feeUsd : null,
      sparklineSinceEntry: earliest?.sparklineSinceEntry ?? lead.sparklineSinceEntry,
      entryUnavailableReason: stocks.find((stock) => stock.entryUnavailableReason)?.entryUnavailableReason ?? null,
      positionKeys: list.map((item) => item.key),
    };
  });
}

export function portfolioTotals(rows: readonly StockRow[]): PortfolioTotals {
  const valueUsd = sumOrNull(rows.map((row) => row.valueUsd));
  const change24hUsd = sumOrNull(rows.map((row) => row.valueUsd !== null && row.change24hPct !== null && row.change24hPct > -100
    ? row.valueUsd * row.change24hPct / (100 + row.change24hPct) : null));
  const priceChangeUsd = sumOrNull(rows.map((row) => row.priceChangeUsd));
  const costUsd = sumOrNull(rows.map((row) => row.sharesIn !== null && row.entryPriceUsd !== null ? row.sharesIn * row.entryPriceUsd : null));
  const feeUsd = sumOrNull(rows.map((row) => row.feeUsd));
  const before24h = valueUsd !== null && change24hUsd !== null ? valueUsd - change24hUsd : null;
  return {
    stocks: rows.length,
    valueUsd,
    change24hUsd,
    change24hPct: change24hUsd !== null && before24h ? change24hUsd / before24h * 100 : null,
    priceChangeUsd,
    costUsd,
    priceChangePct: priceChangeUsd !== null && costUsd ? priceChangeUsd / costUsd * 100 : null,
    feeUsd,
    totalUsd: priceChangeUsd !== null && feeUsd !== null ? priceChangeUsd + feeUsd : null,
  };
}
