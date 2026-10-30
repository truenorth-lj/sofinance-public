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
  /** Pool creation time when known: days before the first candle count as zero instead of "not yet existing". */
  createdAtSeconds?: number,
): DailyVolumeSample | null {
  const complete = points.filter((point) => !isIncompleteUtcDay(point.time, nowSeconds));
  if (complete.length === 0 && createdAtSeconds === undefined) return null;
  const lastDay = lastCompleteUtcDayStart(nowSeconds);
  const windowStart = lastDay - (windowDays - 1) * SECONDS_PER_DAY;
  const created = createdAtSeconds === undefined ? Number.POSITIVE_INFINITY : createdAtSeconds - (createdAtSeconds % SECONDS_PER_DAY);
  const firstSeen = Math.min(created, ...complete.map((point) => point.time));
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

/**
 * Daily USD volume from hourly candles fetched with `currency=token` (volume in token units), priced at one
 * token USD price. Only exact for a pair of two tokens worth the same (Robinhood Chain stock pairs: both
 * sides are the same stock), where it saves the separate daily-candle call.
 */
export function dailyVolumesFromHourly(
  candles: readonly { time: number; volume: number }[], tokenPriceUsd: number,
): GeckoVolumePoint[] {
  const byDay = new Map<number, number>();
  for (const candle of candles) {
    if (!Number.isFinite(candle.time) || !Number.isFinite(candle.volume)) continue;
    const day = candle.time - (candle.time % SECONDS_PER_DAY);
    byDay.set(day, (byDay.get(day) ?? 0) + candle.volume * tokenPriceUsd);
  }
  return [...byDay].sort(([a], [b]) => a - b).map(([time, volumeUsd]) => ({ time, volumeUsd }));
}
