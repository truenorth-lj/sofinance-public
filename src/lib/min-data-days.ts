/**
 * The site's standard fee-estimate window is `MIN_DATA_DAYS` complete UTC days. An estimate is still shown once
 * a pool has `MIN_APR_DATA_DAYS` complete UTC day, labelled "based on N days of data" when the window is shorter.
 * A launch spike on a near-empty pool can still print a high number (AMZNx/AMZN `8ug1sF…`: 3,089% on day one with
 * $248 in it); that figure is held to the pool's real LP fees (`capAprAtPoolFees`) and, under $5k TVL, tagged Low TVL.
 * The open (incomplete) UTC day is never counted.
 */
export const MIN_DATA_DAYS = 7;
/** Complete UTC days needed before any fee estimate is shown, on the cards and in the share calculator. */
export const MIN_APR_DATA_DAYS = 1;

export function hasTooFewDataDays(days: number): boolean {
  return days < MIN_APR_DATA_DAYS;
}

/** The volume window is shorter than the standard 7 complete UTC days. */
export function isShortAprWindow(days: number): boolean {
  return days >= MIN_APR_DATA_DAYS && days < MIN_DATA_DAYS;
}

/** "1 day of data" / "6 days of data". */
export function dataDaysLabel(days: number): string {
  return `${days} ${days === 1 ? "day" : "days"} of data`;
}

/** "based on 3 days of data" — the card and table label when the window is shorter than 7 days. */
export function basedOnDataDaysLabel(days: number): string {
  return `based on ${dataDaysLabel(days)}`;
}

/** One UTC day of a pool's history: its USD volume and TVL, null when unknown. */
export type PoolDataDay = { volumeUsd: number | null | undefined; tvlUsd: number | null | undefined };

/**
 * Days of data: complete UTC days with both a volume figure and a TVL above zero (a day with no trades has no
 * volume candle, so it does not count). The same count the share calculator uses.
 */
export function isDataDay(day: PoolDataDay): boolean {
  const { volumeUsd, tvlUsd } = day;
  return typeof volumeUsd === "number" && Number.isFinite(volumeUsd) && volumeUsd >= 0
    && typeof tvlUsd === "number" && Number.isFinite(tvlUsd) && tvlUsd > 0;
}

export function countDataDays(days: readonly PoolDataDay[]): number {
  return days.filter(isDataDay).length;
}
