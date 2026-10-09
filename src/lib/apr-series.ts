/**
 * Shared daily APR series helpers (no I/O).
 *
 * A day with missing volume or TVL is a gap (`aprPct: null`) — never interpolated.
 */

export const SECONDS_PER_DAY = 86_400;

export type AprRangeDays = 7 | 30 | 90;

export type DailyAprPoint = {
  /** Unix seconds at 00:00 UTC. */
  time: number;
  /** YYYY-MM-DD UTC. */
  date: string;
  /** Annualized fee APR percent for that UTC day, or null when inputs are missing. */
  aprPct: number | null;
  volumeUsd: number | null;
  tvlUsd: number | null;
};

export type ChartValuePoint = {
  time: number;
  date: string;
  value: number | null;
};

export function utcDayStart(time: number): number {
  if (!Number.isFinite(time)) throw new Error("time must be finite");
  return Math.floor(time / SECONDS_PER_DAY) * SECONDS_PER_DAY;
}

export function utcDate(time: number): string {
  return new Date(utcDayStart(time) * 1000).toISOString().slice(0, 10);
}

/** 00:00 UTC of the most recently finished UTC day (yesterday relative to `nowSeconds`). */
export function lastCompleteUtcDayStart(nowSeconds: number): number {
  return utcDayStart(nowSeconds) - SECONDS_PER_DAY;
}

/** True when `time` falls on the still-open UTC day that contains `nowSeconds`. */
export function isIncompleteUtcDay(time: number, nowSeconds: number): boolean {
  return utcDayStart(time) >= utcDayStart(nowSeconds);
}

export function formatAprPct(value: number): string {
  const digits = Math.abs(value) >= 100 ? 1 : 2;
  return `${value.toFixed(digits)}%`;
}

/** Visible label + tooltip copy for the last complete UTC day's APR. */
export function lastCompleteDayAprCopy(date: string, aprPct: number): { label: string; title: string } {
  const pct = formatAprPct(aprPct);
  return {
    label: `${pct} · ${date}`,
    title: `last complete UTC day ${date}: ${pct}`,
  };
}

export function calendarRange(endTime: number, days: AprRangeDays): number[] {
  const end = utcDayStart(endTime);
  const start = end - (days - 1) * SECONDS_PER_DAY;
  const times: number[] = [];
  for (let t = start; t <= end; t += SECONDS_PER_DAY) times.push(t);
  return times;
}

/** Join sparse known values onto a complete UTC day index. Missing days stay null. */
export function calendarizeValues(
  known: ReadonlyMap<number, number | null>,
  endTime: number,
  days: AprRangeDays,
): ChartValuePoint[] {
  return calendarRange(endTime, days).map((time) => {
    const value = known.has(time) ? (known.get(time) ?? null) : null;
    return {
      time,
      date: utcDate(time),
      value: value !== null && Number.isFinite(value) ? value : null,
    };
  });
}

export function calendarizeDailyApr(
  points: readonly DailyAprPoint[],
  endTime: number,
  days: AprRangeDays,
): DailyAprPoint[] {
  const byDay = new Map<number, DailyAprPoint>();
  for (const point of points) {
    byDay.set(utcDayStart(point.time), point);
  }
  return calendarRange(endTime, days).map((time) => {
    const hit = byDay.get(time);
    if (hit) {
      return { ...hit, time, date: utcDate(time) };
    }
    return { time, date: utcDate(time), aprPct: null, volumeUsd: null, tvlUsd: null };
  });
}

/** Contiguous non-null runs. A gap breaks the path so we never fabricate a segment. */
export function lineSegments<T extends { value: number | null }>(points: readonly T[]): T[][] {
  const segments: T[][] = [];
  let current: T[] = [];
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) {
      if (current.length > 0) {
        segments.push(current);
        current = [];
      }
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

export function maxFinite(values: readonly (number | null | undefined)[]): number {
  let max = 0;
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > max) max = value;
  }
  return max;
}
