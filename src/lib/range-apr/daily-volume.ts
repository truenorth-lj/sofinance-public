/**
 * Multi-day average USD volume from GeckoTerminal daily candles (pure).
 *
 * - Only COMPLETE UTC days count (the open day is excluded, like `/api/pool-daily-apr`).
 * - A day with no candle means no trades, so it counts as zero volume.
 * - A pool younger than the window only averages over the days it has existed (first candle onward).
 */
import { SECONDS_PER_DAY, isIncompleteUtcDay, lastCompleteUtcDayStart } from "../apr-series";
import type { GeckoVolumePoint } from "../pool-daily-apr-math";

export const VOLUME_WINDOW_DAYS = 7;

export type DailyVolumeSample = { avgDailyVolumeUsd: number; days: number };

export function averageDailyVolume(
  points: readonly GeckoVolumePoint[],
  nowSeconds: number,
  windowDays = VOLUME_WINDOW_DAYS,
): DailyVolumeSample | null {
  const complete = points.filter((point) => !isIncompleteUtcDay(point.time, nowSeconds));
  if (complete.length === 0) return null;
  const lastDay = lastCompleteUtcDayStart(nowSeconds);
  const windowStart = lastDay - (windowDays - 1) * SECONDS_PER_DAY;
  const firstSeen = Math.min(...complete.map((point) => point.time));
  const start = Math.max(windowStart, firstSeen);
  if (start > lastDay) return null;
  const days = Math.round((lastDay - start) / SECONDS_PER_DAY) + 1;
  const total = complete
    .filter((point) => point.time >= start && point.time <= lastDay)
    .reduce((sum, point) => sum + point.volumeUsd, 0);
  return { avgDailyVolumeUsd: total / days, days };
}

/** Hourly candles that belong to the same complete-UTC-day window as `averageDailyVolume`. */
export function candlesInWindow<T extends { time: number }>(
  candles: readonly T[], nowSeconds: number, days: number,
): T[] {
  const end = lastCompleteUtcDayStart(nowSeconds) + SECONDS_PER_DAY;
  const start = end - days * SECONDS_PER_DAY;
  return candles.filter((candle) => candle.time >= start && candle.time < end);
}
