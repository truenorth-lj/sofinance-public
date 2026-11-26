import { describe, expect, it } from "vitest";
import { aprWindowAvgLabel, aprWindowLabel, PLAN_APR_WINDOWS, selectBestPlanApr, trailingWindowAverage } from "./lp-plan-best-apr";

const DAY = 86_400;
const START = 1_784_000_000 - (1_784_000_000 % DAY); // 00:00 UTC

/** Oldest → newest, one point per UTC day, ending on `START + (n - 1) days`. */
function series(values: Array<number | null>) {
  return values.map((aprPct, index) => ({ time: START + index * DAY, aprPct }));
}
const repeat = (value: number | null, count: number) => Array.from({ length: count }, () => value);

describe("trailingWindowAverage", () => {
  it("counts a day only with both volume and TVL (isDataDay, the cards' day count)", () => {
    const points = [
      ...series(repeat(10, 5)).map((point) => ({ ...point, volumeUsd: 100, tvlUsd: 1_000 })),
      { time: START + 5 * DAY, aprPct: 90, volumeUsd: null, tvlUsd: 1_000 }, // no volume record
      { time: START + 6 * DAY, aprPct: 90, volumeUsd: 100, tvlUsd: 0 }, // no TVL
    ];
    expect(trailingWindowAverage(points, 7)).toMatchObject({ aprPct: "10", sampleDays: 5 });
  });
  it("averages only the last N UTC days that end on the newest point", () => {
    const points = series([...repeat(100, 3), ...repeat(10, 7)]);
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 7, coversAllData: false });
    expect(trailingWindowAverage(points, 10)).toEqual({ windowDays: 10, aprPct: "37", sampleDays: 10, coversAllData: true });
  });

  it("skips gaps inside the window without filling them", () => {
    const points = series([10, null, 30, null, 50, 70, 90]);
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "50", sampleDays: 5, coversAllData: true });
    expect(trailingWindowAverage(points, 2)).toEqual({ windowDays: 2, aprPct: "80", sampleDays: 2, coversAllData: false });
  });

  it("counts a missing calendar day as a gap, not as an older day", () => {
    const points = [
      { time: START, aprPct: 500 },
      { time: START + 9 * DAY, aprPct: 10 },
    ];
    expect(trailingWindowAverage(points, 7)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 1, coversAllData: false });
  });

  it("knows whether the pool's history is older than the window (an older day with no APR still counts)", () => {
    // Raydium-style: 60 days, only the last 29 with an APR (the TVL line starts there).
    const points = series([...repeat(null, 31), ...repeat(10, 29)]);
    expect(trailingWindowAverage(points, 30)).toMatchObject({ sampleDays: 29, coversAllData: false });
    expect(aprWindowAvgLabel(trailingWindowAverage(points, 30)!)).toBe("29-day avg (gap days skipped)");
  });

  it("returns null when the window has nothing finite", () => {
    expect(trailingWindowAverage([], 7)).toBeNull();
    expect(trailingWindowAverage(series(repeat(null, 7)), 7)).toBeNull();
    expect(trailingWindowAverage(series([5, null, null]), 2)).toBeNull();
  });

  it("drops a day that has not finished at asOf", () => {
    const points = series([10, 10, 90]);
    const asOf = START + 2 * DAY + 3600; // the third day is still open
    expect(trailingWindowAverage(points, 7, asOf)).toEqual({ windowDays: 7, aprPct: "10", sampleDays: 2, coversAllData: true });
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
    // The 90-day window holds the same 30 days as the 30-day one, so it is dropped.
    expect(best!.windows.map((w) => [w.windowDays, w.aprPct])).toEqual([
      [7, "40"],
      [30, "17"],
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

  it("prefers the shorter window on a tie", () => {
    // 40 days of 12%: the 30-day window is full and equal to the 7-day one; the 90-day one (40 < 72 days) cannot count.
    const best = selectBestPlanApr(series(repeat(12, 40)));
    expect(best).toMatchObject({ windowDays: 7, aprPct: "12", sampleDays: 7 });
    expect(best!.windows.map((w) => [w.windowDays, w.sampleDays])).toEqual([[7, 7], [30, 30], [90, 40]]);
  });

  it("needs 80% of a window's days (and at least 1) before that window counts", () => {
    // 13 days (NVDAx/NVDA Meteora, Nov 2026): strong first week, weaker last week. 30d and 90d hold the same 13 days.
    const nvda = selectBestPlanApr(series([...repeat(200, 6), ...repeat(80, 7)]))!;
    expect(nvda).toMatchObject({ windowDays: 7, sampleDays: 7, aprPct: "80" });
    expect(nvda.windows.map((w) => [w.windowDays, w.sampleDays])).toEqual([[7, 7], [30, 13]]);
    // 24 of 30 days is enough for the 30-day window; 23 is not.
    expect(selectBestPlanApr(series([...repeat(90, 17), ...repeat(10, 7)]))).toMatchObject({ windowDays: 30, sampleDays: 24 });
    expect(selectBestPlanApr(series([...repeat(90, 16), ...repeat(10, 7)]))).toMatchObject({ windowDays: 7, sampleDays: 7 });
    // 72 of 90 days for the 90-day window.
    expect(selectBestPlanApr(series([...repeat(90, 42), ...repeat(50, 23), ...repeat(10, 7)]))).toMatchObject({ windowDays: 90, sampleDays: 72 });
    expect(selectBestPlanApr(series([...repeat(90, 41), ...repeat(50, 23), ...repeat(10, 7)]))).toMatchObject({ windowDays: 30, sampleDays: 30 });
  });

  it("with no window covered, picks among the windows with at least one complete day, then names it by its days", () => {
    // Two recent gaps leave the 7-day window 5 days (under 80%); the 30-day window holds 13, all the data so far.
    const points = series([...repeat(50, 8), 10, 10, 10, null, null, 10, 10]);
    const best = selectBestPlanApr(points)!;
    expect(best).toMatchObject({ windowDays: 30, sampleDays: 13, coversAllData: true });
    expect(aprWindowAvgLabel(best)).toBe("13-day avg (all data so far)");
  });

  it("ignores a thin window while a well-sampled one exists", () => {
    // The 7-day window has only 3 finite days (all 99); the 30-day window has 26 finite days.
    const points = series([...repeat(10, 26), null, null, null, null, 99, 99, 99]);
    const best = selectBestPlanApr(points);
    expect(best).toMatchObject({ windowDays: 30, sampleDays: 26 });
    expect(best!.windows.find((w) => w.windowDays === 7)).toMatchObject({ aprPct: "99", sampleDays: 3 });
    expect(Number(best!.aprPct)).toBeLessThan(99);
  });

  it("falls back to the short window when no window is fully covered (the numbers are still shown)", () => {
    const best = selectBestPlanApr(series([10, 20, 30]));
    expect(best).toMatchObject({ aprPct: "20", sampleDays: 3, windowDays: 7 });
    expect(best!.windows).toHaveLength(1);
  });

  it("returns null when there is no finite day", () => {
    expect(selectBestPlanApr([])).toBeNull();
    expect(selectBestPlanApr(series(repeat(null, 10)))).toBeNull();
  });
});

describe("aprWindowAvgLabel", () => {
  it("keeps the plain label at full length and never names a window longer than its data", () => {
    expect(aprWindowAvgLabel({ windowDays: 90, sampleDays: 90 })).toBe("90-day avg");
    expect(aprWindowAvgLabel({ windowDays: 90, sampleDays: 13, coversAllData: true })).toBe("13-day avg (all data so far)");
    expect(aprWindowAvgLabel({ windowDays: 30, sampleDays: 29, coversAllData: false })).toBe("29-day avg (gap days skipped)");
    expect(aprWindowAvgLabel({ windowDays: 7, sampleDays: 1, coversAllData: true }, "pool avg")).toBe("1-day pool avg (all data so far)");
    expect(aprWindowAvgLabel({ windowDays: 7, sampleDays: 7 }, "pool avg")).toBe("7-day pool avg");
    for (const sampleDays of [1, 6, 13, 29, 71]) {
      expect(aprWindowAvgLabel({ windowDays: 90, sampleDays, coversAllData: true })).not.toMatch(/90-day/);
    }
  });
});
