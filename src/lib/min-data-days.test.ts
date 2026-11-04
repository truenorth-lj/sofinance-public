import { describe, expect, it } from "vitest";
import { countDataDays, isDataDay } from "./min-data-days";

describe("isDataDay / countDataDays: the one day count for New pool and the calculator", () => {
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
