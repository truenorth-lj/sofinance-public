const DAY_MS = 86_400_000;
/**
 * The Taipei calendar day of `nowMs`: history rows (`rwa_apr_daily`) are dated in Taipei, and each pool's row for
 * a day is written by its first successful refresh of that day (any run of the 4-hourly cron), so there is no
 * fixed capture window. `start` is Taipei midnight (`scheduled_for` of the day's rows).
 * The market-volume window remains complete UTC days (`volumeWindowEnd`).
 */
export function taipeiDay(nowMs: number) {
  const date = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
  return { date, start: Date.parse(`${date}T00:00:00+08:00`) };
}
export const volumeWindowEnd = (nowMs: number) =>
  new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString();

/**
 * The volume window a Taipei day's history row must use: the 7 complete UTC days ending at that date's UTC
 * midnight (`${date}T00:00Z`, i.e. 08:00 Taipei). Before 08:00 Taipei (the 00:15 and 04:15 runs) the current window
 * still ends a day earlier (the previous Taipei day's window), so a refresh then must not count for the new day:
 * one window per day, no duplicate of yesterday's window and no skipped window.
 */
export const taipeiDayWindowEnd = (date: string) => new Date(`${date}T00:00:00.000Z`).toISOString();

/** Whether a refresh at `nowMs` can be the Taipei day's history success (its window is that day's: ≥ 08:00 Taipei). */
export const countsForTaipeiDay = (nowMs: number) => volumeWindowEnd(nowMs) === taipeiDayWindowEnd(taipeiDay(nowMs).date);

export function validateHistoryRange(from: string, to: string) {
  const valid = (value: string) =>
    value.slice(0, 4) !== "0000" &&
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
  if (
    !valid(from) ||
    !valid(to) ||
    to < from ||
    Date.parse(to) - Date.parse(from) > 365 * DAY_MS
  ) {
    throw new Error("History requires valid dates and at most 366 days");
  }
}
