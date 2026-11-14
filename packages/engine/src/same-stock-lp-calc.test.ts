import { describe, expect, it } from "vitest";
import { breakEvenSpreadMove, estimateSameStockLp, type SameStockLpInput } from "./same-stock-lp-calc";

const base: SameStockLpInput = {
  depositUsd: 1000,
  halfWidth: 0.003,
  feeApr: 0.2,
  inRangeShare: 1,
  days: 30,
  spreadMove: 0.003,
  entrySwappedShare: 0.5,
  swapImpact: 0.0005,
  networkFeesUsd: 0.01,
};

describe("estimateSameStockLp", () => {
  it("has no impermanent loss when the two tokens do not drift apart", () => {
    const result = estimateSameStockLp({ ...base, spreadMove: 0 });
    expect(result.impermanentLossUsd).toBeCloseTo(0, 9);
    expect(result.positionValueUsd).toBeCloseTo(1000, 9);
    expect(result.inRange).toBe(true);
  });

  it.each([
    [0.001, 0.0834, 15.595, 1.54],
    [0.003, 0.7494, 14.9289, 2.75],
    [0.01, 4.2442, 11.4342, 9.13],
    [0.02, 9.2367, 6.4417, 18.24],
  ])("matches the reference table at a %s spread move", (move, il, net, days) => {
    const result = estimateSameStockLp({ ...base, spreadMove: move });
    expect(result.impermanentLossUsd).toBeCloseTo(il, 3);
    expect(result.feesCollectedUsd).toBeCloseTo(16.4384, 3);
    expect(result.costsUsd).toBeCloseTo(0.76, 6);
    expect(result.netVsHoldUsd).toBeCloseTo(net, 3);
    expect(result.breakEvenDays).toBeCloseTo(days, 1);
  });

  it("charges wider ranges less impermanent loss for the same move", () => {
    const il = (halfWidth: number) => estimateSameStockLp({ ...base, halfWidth }).impermanentLossUsd;
    expect(il(0.0005)).toBeGreaterThan(il(0.003));
    expect(il(0.003)).toBeGreaterThan(il(0.01));
  });

  it("is continuous at the range edges", () => {
    const edge = 0.003;
    const inside = estimateSameStockLp({ ...base, spreadMove: edge - 1e-9 }).positionValueUsd;
    const outside = estimateSameStockLp({ ...base, spreadMove: edge + 1e-9 }).positionValueUsd;
    expect(inside).toBeCloseTo(outside, 5);
    const lowerInside = estimateSameStockLp({ ...base, spreadMove: -edge + 1e-9 }).positionValueUsd;
    const lowerOutside = estimateSameStockLp({ ...base, spreadMove: -edge - 1e-9 }).positionValueUsd;
    expect(lowerInside).toBeCloseTo(lowerOutside, 5);
  });

  it("collects fees only for the in-range share", () => {
    const half = estimateSameStockLp({ ...base, inRangeShare: 0.5 });
    expect(half.feesCollectedUsd).toBeCloseTo(16.4384 / 2, 3);
  });

  it("charges no SoFinance fee when nothing is swapped", () => {
    const result = estimateSameStockLp({ ...base, entrySwappedShare: 0, networkFeesUsd: 0, exitConvertedShare: 0 });
    expect(result.costsUsd).toBe(0);
  });

  it("returns a null break-even when no fees accrue", () => {
    expect(estimateSameStockLp({ ...base, feeApr: 0 }).breakEvenDays).toBeNull();
  });

  it("rejects invalid input", () => {
    expect(() => estimateSameStockLp({ ...base, depositUsd: 0 })).toThrow();
    expect(() => estimateSameStockLp({ ...base, halfWidth: 0 })).toThrow();
    expect(() => estimateSameStockLp({ ...base, inRangeShare: 1.5 })).toThrow();
    expect(() => estimateSameStockLp({ ...base, spreadMove: -1 })).toThrow();
  });
});

describe("breakEvenSpreadMove", () => {
  const rest: Omit<SameStockLpInput, "spreadMove"> = {
    depositUsd: base.depositUsd, halfWidth: base.halfWidth, feeApr: base.feeApr, inRangeShare: base.inRangeShare, days: base.days,
    entrySwappedShare: base.entrySwappedShare, swapImpact: base.swapImpact, networkFeesUsd: base.networkFeesUsd,
  };

  it("finds the move where fees stop covering impermanent loss and costs", () => {
    const up = breakEvenSpreadMove(rest, 1);
    expect(up).toBeCloseTo(0.0329, 3);
    expect(estimateSameStockLp({ ...rest, spreadMove: up }).netVsHoldUsd).toBeCloseTo(0, 4);
    expect(breakEvenSpreadMove(rest, -1)).toBeGreaterThan(0);
  });

  it("is 0 when costs alone exceed fees", () => {
    expect(breakEvenSpreadMove({ ...rest, feeApr: 0 }, 1)).toBe(0);
  });
});
