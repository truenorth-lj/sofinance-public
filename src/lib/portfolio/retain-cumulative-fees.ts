import type { PortfolioPosition } from "./model";

const cache = new Map<string, number>();

export function resetRetainedCumulativeFees(): void {
  cache.clear();
}

const cacheKey = (wallet: string, key: string) => `${wallet}:${key}`;

/**
 * Once a position has returned a complete cumulative-fee figure, keep that number while a later
 * read is still updating or incomplete (the row labels it as updating). A position that has never
 * had a complete ledger stays a dash. Failed rows are left alone.
 */
export function retainCumulativeFees(wallet: string, row: PortfolioPosition): PortfolioPosition {
  const key = cacheKey(wallet, row.key);
  const current = row.figures.cumulativeFeesUsd;
  if (row.historyComplete && typeof current === "number" && Number.isFinite(current)) {
    cache.set(key, current);
    return row;
  }
  if (row.status === "failed" || current !== null) return row;
  const last = cache.get(key);
  if (last === undefined) return row;
  return { ...row, figures: { ...row.figures, cumulativeFeesUsd: last } };
}
