import { describe, expect, it } from "vitest";
import { buildPlanComparison, planEntryCost } from "./lp-plan-yield";
import { endShares, lowPlanApr, planShareSymbol, profitToShareDelta } from "./lp-plan-shares";

function plan(capital: string, days: number, aprPct: string) {
  return buildPlanComparison({ capital, days, aprPct, sampleDays: 29, aprWindowDays: 30, entryCost: planEntryCost(capital) });
}

describe("planShareSymbol", () => {
  it("counts a same-stock pair in its plain stock symbol", () => {
    expect(planShareSymbol({ wrappedSymbol: "SPCXx", plainSymbol: "SPCX" })).toBe("SPCX");
  });

  it("has no share view for the stablecoin pool or a missing side", () => {
    expect(planShareSymbol({ wrappedSymbol: "USDC", plainSymbol: "USDT" })).toBeNull();
    expect(planShareSymbol({ wrappedSymbol: "SPCXx" })).toBeNull();
    expect(planShareSymbol(undefined)).toBeNull();
  });
});

describe("share view math", () => {
  it("does not depend on the amount put in", () => {
    const small = plan("100", 365, "11.2");
    const large = plan("100000", 365, "11.2");
    expect(Number(endShares(small))).toBeCloseTo(Number(endShares(large)), 9);
  });

  it("starts below 100 by the opening cost and grows with the compounded yield", () => {
    const comparison = plan("1000", 365, "11.2");
    // Day 0: −1% opening cost → 99 per 100 held.
    expect(Number(profitToShareDelta(comparison.points[0]!.sofinance, comparison.capital))).toBeCloseTo(-1, 9);
    // 1,000 × (1 + 0.112/365)^365 − 1,000 − 10, as shares per 100 held.
    expect(Number(endShares(comparison))).toBeCloseTo(100 + (Math.pow(1 + 0.112 / 365, 365) - 1) * 100 - 1, 6);
  });
});

describe("lowPlanApr", () => {
  const best = { windowDays: 90, aprPct: "11.2", sampleDays: 90 };

  it("returns the lowest well-sampled window below the best", () => {
    const windows = [
      { windowDays: 7, aprPct: "7.7", sampleDays: 7 },
      { windowDays: 30, aprPct: "11.2", sampleDays: 30 },
      best,
    ];
    expect(lowPlanApr(best, windows)).toEqual({ windowDays: 7, aprPct: "7.7", sampleDays: 7 });
  });

  it("ignores a thin window while a well-sampled one exists", () => {
    const windows = [{ windowDays: 7, aprPct: "1", sampleDays: 3 }, best];
    expect(lowPlanApr(best, windows)).toBeNull();
  });

  it("has no range when every window matches the best", () => {
    expect(lowPlanApr(best, [best])).toBeNull();
  });
});
