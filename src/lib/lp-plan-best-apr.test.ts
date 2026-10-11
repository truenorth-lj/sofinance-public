import { describe, expect, it } from "vitest";
import { aprWindowLabel, PLAN_APR_WINDOWS, selectBestPlanApr, trailingWindowAverage } from "./lp-plan-best-apr";

const DAY = 86_400;
const START = 1_784_000_000 - (1_784_000_000 % DAY); // 00:00 UTC

/** Oldest → newest, one point per UTC day, ending on `START + (n - 1) days`. */
function series(values: Array<number | null>) {
  return values.map((aprPct, index) => ({ time: START + index * DAY, aprPct }));
}
const repeat = (value: number | null, count: number) => Array.from({ length: count }, () => value);

describe("trailingWindowAverage", () => {
  it("averages only the last N UTC days that end on the newest point", () => {
    const points = series([...repeat(100, 3), ...repeat(10, 7)]);
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 7 });
    expect(trailingWindowAverage(points, 10)).toEqual({ windowDays: 10, aprPct: "37", sampleDays: 10 });
  });

  it("skips gaps inside the window without filling them", () => {
    const points = series([10, null, 30, null, 50, 70, 90]);
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "50", sampleDays: 5 });
    expect(trailingWindowAverage(points, 2)).toEqual({ windowDays: 2, aprPct: "80", sampleDays: 2 });
  });

  it("counts a missing calendar day as a gap, not as an older day", () => {
    const points = [
      { time: START, aprPct: 500 },
      { time: START + 9 * DAY, aprPct: 10 },
    ];
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 1 });
  });

  it("returns null when the window has nothing finite", () => {
    expect(trailingWindowAverage([], 7)).toBeNull();
    expect(trailingWindowAverage(series(repeat(null, 7)), 7)).toBeNull();
    expect(trailingWindowAverage(series([5, null, null]), 2)).toBeNull();
  });

  it("drops a day that has not finished at asOf", () => {
    const points = series([10, 10, 90]);
    const asOf = START + 2 * DAY + 3600; // the third day is still open
    expect(trailingWindowAverage(points, 7, asOf)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 2 });
    expect(trailingWindowAverage(points, 7, START + 3 * DAY + 3600)?.sampleDays).toBe(3);
  });

  it("rejects a bad window", () => {
    expect(() => trailingWindowAverage([], 0)).toThrow(/windowDays/);
  });
});

describe("selectBestPlanApr", () => {
  it("compares 7, 30 and 90-day windows", () => {
    expect(PLAN_APR_WINDOWS).toEqual([7, 30, 90]);
    expect(aprWindowLabel(7)).toBe("7-day");
  });

  it("picks the 7-day average when the latest week is the strongest", () => {
    const best = selectBestPlanApr(series([...repeat(10, 23), ...repeat(40, 7)]));
    expect(best).toMatchObject({ windowDays: 7, aprPct: "40", sampleDays: 7 });
    expect(best!.windows.map((w) => [w.windowDays, w.aprPct])).toEqual([
      [7, "40"],
      [30, "17"],
      [90, "17"],
    ]);
  });

  it("picks the 30-day average when the latest week has cooled off", () => {
    const best = selectBestPlanApr(series([...repeat(5, 60), ...repeat(30, 23), ...repeat(5, 7)]));
    expect(best).toMatchObject({ windowDays: 30, sampleDays: 30 });
    expect(Number(best!.aprPct)).toBeCloseTo((30 * 23 + 5 * 7) / 30, 8);
  });

  it("picks the 90-day average when the older history is the strongest", () => {
    const best = selectBestPlanApr(series([...repeat(60, 60), ...repeat(10, 30)]));
    expect(best).toMatchObject({ windowDays: 90, sampleDays: 90 });
    expect(Number(best!.aprPct)).toBeCloseTo(43.333333, 4);
  });

  it("prefers the longer window on a tie", () => {
    expect(selectBestPlanApr(series(repeat(12, 40)))).toMatchObject({ windowDays: 90, aprPct: "12", sampleDays: 40 });
  });

  it("ignores a thin window while a well-sampled one exists", () => {
    // The 7-day window has only 3 finite days (all 99); the 30-day window has 26 finite days.
    const points = series([...repeat(10, 26), null, null, null, null, 99, 99, 99]);
    const best = selectBestPlanApr(points);
    expect(best).toMatchObject({ windowDays: 30, sampleDays: 26 });
    expect(best!.windows.find((w) => w.windowDays === 7)).toMatchObject({ aprPct: "99", sampleDays: 3 });
    expect(Number(best!.aprPct)).toBeLessThan(99);
  });

  it("falls back to the highest thin window when no window has a week of data", () => {
    const best = selectBestPlanApr(series([10, 20, 30]));
    expect(best).toMatchObject({ aprPct: "20", sampleDays: 3, windowDays: 90 });
  });

  it("returns null when there is no finite day", () => {
    expect(selectBestPlanApr([])).toBeNull();
    expect(selectBestPlanApr(series(repeat(null, 10)))).toBeNull();
  });
});
