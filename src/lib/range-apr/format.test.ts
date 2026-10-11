import { describe, expect, it } from "vitest";
import { formatAprPct, formatEstimate, unavailableReasonText } from "./format";

describe("formatAprPct", () => {
  it("uses one decimal below 10%, none above, and caps huge values", () => {
    expect(formatAprPct(7.66)).toBe("~7.7%");
    expect(formatAprPct(154.06)).toBe("~154%");
    expect(formatAprPct(9.96)).toBe("~10.0%");
    expect(formatAprPct(999.4)).toBe("~999%");
    expect(formatAprPct(1000)).toBe("1,000%+");
    expect(formatAprPct(52_000)).toBe("1,000%+");
  });

  it("shows ~0% for tiny values and a dash for invalid ones", () => {
    expect(formatAprPct(0)).toBe("~0%");
    expect(formatAprPct(0.04)).toBe("~0%");
    expect(formatAprPct(Number.NaN)).toBe("—");
    expect(formatAprPct(-1)).toBe("—");
  });
});

describe("formatEstimate / unavailableReasonText", () => {
  it("formats ok estimates and dashes unavailable or missing ones", () => {
    expect(formatEstimate({ status: "ok", aprPct: 12.34, inRangeVolumePct: 50, feesPerDayUsd: 1 })).toBe("~12%");
    expect(formatEstimate({ status: "unavailable", reason: "no-price" })).toBe("—");
    expect(formatEstimate(undefined)).toBe("—");
  });

  it("has a human sentence for every unavailable reason", () => {
    for (const reason of ["invalid-range", "range-outside-window", "no-price", "no-capital"] as const) {
      expect(unavailableReasonText(reason).length).toBeGreaterThan(10);
    }
  });
});
