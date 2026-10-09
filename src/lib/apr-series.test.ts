import { describe, expect, it } from "vitest";
import {
  calendarRange,
  calendarizeDailyApr,
  calendarizeValues,
  isIncompleteUtcDay,
  lastCompleteDayAprCopy,
  lastCompleteUtcDayStart,
  lineSegments,
  maxFinite,
  utcDate,
  utcDayStart,
} from "./apr-series";

const DAY = 86_400;
// 2026-10-09 00:00 UTC
const END = 1_791_504_000;

describe("apr-series", () => {
  it("snaps unix times to UTC midnight and formats dates", () => {
    expect(utcDayStart(END + 12_345)).toBe(END);
    expect(utcDate(END + 1)).toBe("2026-10-09");
  });

  it("builds a complete 7-day UTC index ending on the given day", () => {
    const days = calendarRange(END + 100, 7);
    expect(days).toHaveLength(7);
    expect(days[0]).toBe(END - 6 * DAY);
    expect(days[6]).toBe(END);
  });

  it("calendarizes known APR points and leaves missing days as gaps", () => {
    const points = calendarizeDailyApr(
      [
        { time: END - 2 * DAY, date: "2026-10-07", aprPct: 12.5, volumeUsd: 1000, tvlUsd: 10_000 },
        { time: END, date: "2026-10-09", aprPct: 8, volumeUsd: 800, tvlUsd: 11_000 },
      ],
      END,
      7,
    );
    expect(points).toHaveLength(7);
    expect(points.filter((p) => p.aprPct !== null)).toHaveLength(2);
    expect(points[4]).toMatchObject({ date: "2026-10-07", aprPct: 12.5 });
    expect(points[5]).toMatchObject({ date: "2026-10-08", aprPct: null, volumeUsd: null, tvlUsd: null });
    expect(points[6]).toMatchObject({ date: "2026-10-09", aprPct: 8 });
  });

  it("breaks line segments on gaps instead of interpolating", () => {
    const known = new Map<number, number | null>([
      [END - 6 * DAY, 10],
      [END - 5 * DAY, 11],
      [END - 3 * DAY, 9],
    ]);
    const series = calendarizeValues(known, END, 7);
    const segments = lineSegments(series);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.map((p) => p.date)).toEqual(["2026-10-03", "2026-10-04"]);
    expect(segments[1]?.map((p) => p.date)).toEqual(["2026-10-06"]);
  });

  it("uses 0 as the default max when every value is null", () => {
    expect(maxFinite([null, undefined])).toBe(0);
    expect(maxFinite([null, 4, 1.5])).toBe(4);
  });

  it("treats the UTC day containing a fixed clock as incomplete", () => {
    const midDay = END + 15 * 3600; // 2026-10-09 15:00 UTC
    expect(lastCompleteUtcDayStart(midDay)).toBe(END - DAY);
    expect(utcDate(lastCompleteUtcDayStart(midDay))).toBe("2026-10-08");
    expect(isIncompleteUtcDay(END, midDay)).toBe(true);
    expect(isIncompleteUtcDay(END - DAY, midDay)).toBe(false);
    expect(isIncompleteUtcDay(END, END)).toBe(true);
  });

  it("labels the last complete UTC day for sparkline tooltip and visible text", () => {
    expect(lastCompleteDayAprCopy("2026-10-08", 17.2)).toEqual({
      label: "17.20% · 2026-10-08",
      title: "last complete UTC day 2026-10-08: 17.20%",
    });
    expect(lastCompleteDayAprCopy("2026-10-08", 114.57).label).toBe("114.6% · 2026-10-08");
  });
});
