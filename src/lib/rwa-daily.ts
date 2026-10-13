const DAY_MS = 86_400_000;
/** Observations are dated in Taipei; the market-volume window remains complete UTC days. */
export function dailyWindow(nowMs: number) {
  const date = new Date(nowMs + 8 * 3_600_000).toISOString().slice(0, 10);
  const start = Date.parse(`${date}T00:10:00Z`); // 08:10 Taipei
  const end = Date.parse(`${date}T01:10:00Z`); // 09:10 Taipei
  return { date, start, end, eligible: nowMs >= start && nowMs < end };
}
export const volumeWindowEnd = (nowMs: number) =>
  new Date(Math.floor(nowMs / DAY_MS) * DAY_MS).toISOString();

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
