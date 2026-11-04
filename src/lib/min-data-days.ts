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
