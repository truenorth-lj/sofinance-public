/**
 * Complete UTC days of trading data a pool needs before any fee estimate is shown, on the cards (7-day range APR) and
 * in the share calculator. A pool's first days are often a launch spike on a near-empty pool (AMZNx/AMZN `8ug1sF…`:
 * 3,089% on day one with $248 in it), and averaging a few of them gives numbers in the thousands of percent.
 */
export const MIN_DATA_DAYS = 7;

export function hasTooFewDataDays(days: number): boolean {
  return days < MIN_DATA_DAYS;
}

/** "1 day of data" / "6 days of data". */
export function dataDaysLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"} of data`;
}

/** One UTC day of a pool's history: its USD volume and TVL, null when unknown. */
export type PoolDataDay = { volumeUsd: number | null | undefined; tvlUsd: number | null | undefined };

/**
 * Days of data: complete UTC days with both a volume figure and a TVL above zero (a day with no trades has no
 * volume candle, so it does not count). The one count behind
 * "New pool" on the cards and table and the share calculator's 7-day minimum, so both always agree.
 */
export function isDataDay(day: PoolDataDay): boolean {
  const { volumeUsd, tvlUsd } = day;
  return typeof volumeUsd === "number" && Number.isFinite(volumeUsd) && volumeUsd >= 0
    && typeof tvlUsd === "number" && Number.isFinite(tvlUsd) && tvlUsd > 0;
}

export function countDataDays(days: readonly PoolDataDay[]): number {
  return days.filter(isDataDay).length;
}
