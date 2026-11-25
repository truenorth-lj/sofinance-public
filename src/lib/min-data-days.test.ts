import { describe, expect, it } from "vitest";
import {
  basedOnDataDaysLabel, countDataDays, dataDaysLabel, hasTooFewDataDays, isDataDay, isShortAprWindow,
  MIN_APR_DATA_DAYS, MIN_DATA_DAYS,
} from "./min-data-days";

describe("isDataDay / countDataDays: the one day count for the cards and the calculator", () => {
  it("needs a volume figure (zero is a real quiet day) and a TVL above zero", () => {
    expect(isDataDay({ volumeUsd: 0, tvlUsd: 1 })).toBe(true);
    expect(isDataDay({ volumeUsd: 12.5, tvlUsd: 1_884 })).toBe(true);
    expect(isDataDay({ volumeUsd: null, tvlUsd: 1_884 })).toBe(false);
    expect(isDataDay({ volumeUsd: undefined, tvlUsd: 1_884 })).toBe(false);
    expect(isDataDay({ volumeUsd: 10, tvlUsd: 0 })).toBe(false);
    expect(isDataDay({ volumeUsd: Number.NaN, tvlUsd: 5 })).toBe(false);
    expect(isDataDay({ volumeUsd: -1, tvlUsd: 5 })).toBe(false);
  });
  it("counts the days that qualify", () => {
    expect(countDataDays([{ volumeUsd: 1, tvlUsd: 1 }, { volumeUsd: null, tvlUsd: 1 }, { volumeUsd: 2, tvlUsd: 3 }])).toBe(2);
    expect(countDataDays([])).toBe(0);
  });
});

describe("the display gate: show an estimate from 1 complete UTC day", () => {
  it("hides only a window with no complete day, and labels windows shorter than 7 days", () => {
    expect(MIN_APR_DATA_DAYS).toBe(1);
    expect(MIN_DATA_DAYS).toBe(7);
    expect(hasTooFewDataDays(0)).toBe(true);
    expect(hasTooFewDataDays(1)).toBe(false);
    expect(hasTooFewDataDays(6)).toBe(false);
    expect(hasTooFewDataDays(7)).toBe(false);
    expect(isShortAprWindow(0)).toBe(false);
    expect(isShortAprWindow(1)).toBe(true);
    expect(isShortAprWindow(6)).toBe(true);
    expect(isShortAprWindow(7)).toBe(false);
    expect(dataDaysLabel(1)).toBe("1 day of data");
    expect(basedOnDataDaysLabel(3)).toBe("based on 3 days of data");
  });
});
