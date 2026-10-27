import { describe, expect, it } from "vitest";
import {
  calendarRange,
  calendarizeValues,
  isIncompleteUtcDay,
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
});
