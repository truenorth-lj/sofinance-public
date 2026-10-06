import { describe, expect, it } from "vitest";
import { formatAmount, meetsResaleFloor, parseResaleFloorBps, parseTokenAmount, resaleFloorFromMaxCostPercent } from "./amount";
import BN from "bn.js";
import { LiquidityMathUtil, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { allocateSpend, positionSide, quoteIsFresh } from "./quote-math";

describe("token amount bounds", () => {
  it("parses token precision exactly without floating point", () => {
    expect(parseTokenAmount("100.000001", 6)).toBe(100_000_001n);
    expect(formatAmount(100_000_001n, 6)).toBe("100.000001");
    expect(() => parseTokenAmount("0.0000001", 6)).toThrow();
    expect(() => parseTokenAmount("-1", 6)).toThrow();
    expect(() => parseTokenAmount("0", 6)).toThrow();
  });
});

describe("narrow range allocation and quote gates", () => {
  it("uses only token A below and only token B above the fixed ticks, including the boundaries", () => {
    const lower = TickUtil.getSqrtPriceAtTick(46054);
    const upper = TickUtil.getSqrtPriceAtTick(46058);
    const below = TickUtil.getSqrtPriceAtTick(46053);
    const above = TickUtil.getSqrtPriceAtTick(46059);
    expect(positionSide(BigInt(below.toString()), BigInt(lower.toString()), BigInt(upper.toString()))).toBe("below");
    expect(positionSide(BigInt(lower.toString()), BigInt(lower.toString()), BigInt(upper.toString()))).toBe("below");
    expect(positionSide(BigInt(upper.toString()), BigInt(lower.toString()), BigInt(upper.toString()))).toBe("above");
    expect(positionSide(BigInt(above.toString()), BigInt(lower.toString()), BigInt(upper.toString()))).toBe("above");
    const liquidity = new BN("1000000000000000000");
    const belowAmounts = LiquidityMathUtil.getAmountsForLiquidity(below, lower, upper, liquidity, true);
    const aboveAmounts = LiquidityMathUtil.getAmountsForLiquidity(above, lower, upper, liquidity, true);
    expect(belowAmounts.amountA.gt(new BN(0))).toBe(true);
    expect(belowAmounts.amountB.isZero()).toBe(true);
    expect(aboveAmounts.amountA.isZero()).toBe(true);
    expect(aboveAmounts.amountB.gt(new BN(0))).toBe(true);
    expect(LiquidityMathUtil.getLiquidityFromAmounts(below, lower, upper, belowAmounts.amountA, new BN(0)).gt(new BN(0))).toBe(true);
    expect(LiquidityMathUtil.getLiquidityFromAmounts(above, lower, upper, new BN(0), aboveAmounts.amountB).gt(new BN(0))).toBe(true);
  });
  it("allocates 95/5 when target raw quantities and route rates imply 95/5", () => {
    expect(allocateSpend(100_000_000n, 95n, 5n, { spend: 1_000_000n, out: 1_000_000n }, { spend: 1_000_000n, out: 1_000_000n })).toBe(95_000_000n);
    expect(() => allocateSpend(10_000_000n, 999n, 1n, { spend: 1n, out: 1n }, { spend: 1n, out: 1n })).toThrow(/below/);
  });
  it("requires the visible 99% immediate resale estimate and rejects expiry", () => {
    expect(meetsResaleFloor(100_000_000n, 99_000_000n, 9_900)).toBe(true);
    expect(meetsResaleFloor(100_000_000n, 98_999_999n, 9_900)).toBe(false);
    expect(quoteIsFresh(20_000, 19_999)).toBe(true);
    expect(quoteIsFresh(20_000, 20_000)).toBe(false);
  });
  it("keeps the user's resale cost setting within 0–5% and changes only the estimate gate", () => {
    expect(resaleFloorFromMaxCostPercent("1.0")).toBe(9_900);
    expect(resaleFloorFromMaxCostPercent("1.1")).toBe(9_890);
    expect(resaleFloorFromMaxCostPercent("0")).toBe(10_000);
    expect(resaleFloorFromMaxCostPercent("5.0")).toBe(9_500);
    expect(() => resaleFloorFromMaxCostPercent("5.1")).toThrow();
    expect(() => resaleFloorFromMaxCostPercent("1.05")).toThrow();
    expect(parseResaleFloorBps(undefined)).toBe(9_900);
    expect(parseResaleFloorBps(9_890)).toBe(9_890);
    expect(() => parseResaleFloorBps(9_400)).toThrow();
    expect(() => parseResaleFloorBps(9_899)).toThrow();
    expect(meetsResaleFloor(20_000_000n, 19_786_725n, 9_900)).toBe(false);
    expect(meetsResaleFloor(20_000_000n, 19_786_725n, 9_890)).toBe(true);
  });
});
