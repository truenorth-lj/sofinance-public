import { describe, expect, it } from "vitest";
import { averageDailyVolume, candlesInWindow, dailyVolumesFromHourly } from "./daily-volume";

const DAY = 86_400;
const D0 = 1_791_331_200; // a UTC midnight
const NOW = D0 + 10 * DAY + 3_600; // 01:00 UTC on day 10 (day 10 is incomplete)
const point = (day: number, volumeUsd: number) => ({ time: D0 + day * DAY, volumeUsd });

describe("averageDailyVolume", () => {
  it("averages the last 7 complete UTC days and excludes the open day", () => {
    const points = [point(2, 700), point(3, 100), point(4, 100), point(5, 100), point(6, 100), point(7, 100), point(8, 100), point(9, 100), point(10, 99_999)];
    expect(averageDailyVolume(points, NOW)).toEqual({ avgDailyVolumeUsd: 100, days: 7 });
  });

  it("counts missing days inside the window as zero (no trades)", () => {
    const points = [point(3, 700)]; // first seen day 3; window = days 4..9? no: first seen is day 3 -> window starts at max(day 3, day 3)
    expect(averageDailyVolume(points, NOW)).toEqual({ avgDailyVolumeUsd: 100, days: 7 });
  });

  it("only averages over the days a young pool has existed", () => {
    const points = [point(8, 300), point(9, 100)];
    expect(averageDailyVolume(points, NOW)).toEqual({ avgDailyVolumeUsd: 200, days: 2 });
  });

  it("ignores volume older than the window", () => {
    const points = [point(0, 1_000_000), point(9, 70)];
    // first seen day 0 so the window is the 7 days 3..9: the old spike is outside it
    expect(averageDailyVolume(points, NOW)).toEqual({ avgDailyVolumeUsd: 10, days: 7 });
  });

  it("returns null when there is nothing complete", () => {
    expect(averageDailyVolume([], NOW)).toBeNull();
    expect(averageDailyVolume([point(10, 5)], NOW)).toBeNull();
  });

  it("supports another window length", () => {
    expect(averageDailyVolume([point(8, 30), point(9, 90)], NOW, 2)).toEqual({ avgDailyVolumeUsd: 60, days: 2 });
  });
});

describe("candlesInWindow", () => {
  it("keeps candles from the last N complete days only", () => {
    const candles = [D0 + 2 * DAY, D0 + 3 * DAY, D0 + 9 * DAY + 23 * 3_600, D0 + 10 * DAY].map((time) => ({ time }));
    expect(candlesInWindow(candles, NOW, 7).map((candle) => candle.time)).toEqual([D0 + 3 * DAY, D0 + 9 * DAY + 23 * 3_600]);
  });
});

describe("averageDailyVolume with the pool creation time", () => {
  it("counts quiet days after creation as zero and allows no candles at all", () => {
    expect(averageDailyVolume([], NOW)).toBeNull();
    expect(averageDailyVolume([], NOW, 7, D0)).toEqual({ avgDailyVolumeUsd: 0, days: 7 });
    // created on day 7, one trade day 8: days 7, 8, 9
    expect(averageDailyVolume([point(8, 90)], NOW, 7, D0 + 7 * DAY + 5_000)).toEqual({ avgDailyVolumeUsd: 30, days: 3 });
    expect(averageDailyVolume([point(8, 90)], NOW)).toEqual({ avgDailyVolumeUsd: 45, days: 2 });
  });
});

describe("dailyVolumesFromHourly", () => {
  it("sums hourly token volume per UTC day at the token USD price", () => {
    const candles = [{ time: D0 + 3_600, volume: 2 }, { time: D0 + 7_200, volume: 3 }, { time: D0 + DAY + 60, volume: 1 }];
    expect(dailyVolumesFromHourly(candles, 10)).toEqual([{ time: D0, volumeUsd: 50 }, { time: D0 + DAY, volumeUsd: 10 }]);
    expect(dailyVolumesFromHourly([], 10)).toEqual([]);
    expect(dailyVolumesFromHourly([{} as never, { time: D0, volume: Number.NaN }, { time: D0, volume: 1 }], 10)).toEqual([{ time: D0, volumeUsd: 10 }]);
  });
});
