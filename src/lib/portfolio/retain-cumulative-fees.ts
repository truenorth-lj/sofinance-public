import type { PortfolioPosition } from "./model";
import { isHistoryCatchingUp } from "./figures";

const cache = new Map<string, number>();

export function resetRetainedCumulativeFees(): void {
  cache.clear();
}

const cacheKey = (wallet: string, key: string) => `${wallet}:${key}`;

/**
 * Once a position has returned a complete cumulative-fee figure, keep that number while a later
 * read is still catching up (updating, stale, or unavailable). The row is marked `retained` so the
 * UI can label it as updating and the totals can treat it as a last complete value, not a current
 * one. A position that has never had a complete ledger stays a dash. Failed rows, and a null that
 * is not from catching-up history (for example a missing USD price), are left alone.
 */
export function retainCumulativeFees(wallet: string, row: PortfolioPosition): PortfolioPosition {
  const key = cacheKey(wallet, row.key);
  const current = row.figures.cumulativeFeesUsd;
  if (row.historyComplete && typeof current === "number" && Number.isFinite(current)) {
    cache.set(key, current);
    return row.retained ? { ...row, retained: false } : row;
  }
  if (row.status === "failed" || current !== null || !isHistoryCatchingUp(row.historyStatus)) return row;
  const last = cache.get(key);
  if (last === undefined) return row;
  return { ...row, retained: true, figures: { ...row.figures, cumulativeFeesUsd: last } };
}
