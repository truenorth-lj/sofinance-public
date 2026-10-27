import { describe, expect, it } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { staysInLiquidityBand, tickSpacingBand } from "./liquidity-band";

const sqrt = (tick: number) => TickUtil.getSqrtPriceAtTick(tick);
const mid = (a: number, b: number) => sqrt(a).add(sqrt(b)).divn(2);

describe("tickSpacingBand", () => {
  it("floors to the spacing for positive and negative ticks", () => {
    expect(tickSpacingBand(46069, 60)).toEqual({ lower: 46020, upper: 46080 });
    expect(tickSpacingBand(46020, 60)).toEqual({ lower: 46020, upper: 46080 });
    expect(tickSpacingBand(-1, 60)).toEqual({ lower: -60, upper: 0 });
    expect(tickSpacingBand(-60, 60)).toEqual({ lower: -60, upper: 0 });
    expect(tickSpacingBand(7, 1)).toEqual({ lower: 7, upper: 8 });
  });
  it("rejects invalid spacing", () => {
    expect(() => tickSpacingBand(0, 0)).toThrow(/tick spacing/);
    expect(() => tickSpacingBand(1.5, 60)).toThrow(/tick spacing/);
  });
});

describe("staysInLiquidityBand", () => {
  const start = mid(46069, 46070);
  it("accepts an unchanged price", () => {
    expect(staysInLiquidityBand(start, start, 46069, 60)).toBe(true);
  });
  it("accepts moves across raw (uninitializable) ticks inside the spacing band", () => {
    expect(staysInLiquidityBand(start, mid(46075, 46076), 46069, 60)).toBe(true);
    expect(staysInLiquidityBand(start, mid(46021, 46022), 46069, 60)).toBe(true);
    expect(staysInLiquidityBand(start, sqrt(46020), 46069, 60)).toBe(true);
  });
  it("rejects reaching the upper band edge or leaving below the lower edge", () => {
    expect(staysInLiquidityBand(start, sqrt(46080), 46069, 60)).toBe(false);
    expect(staysInLiquidityBand(start, mid(46080, 46081), 46069, 60)).toBe(false);
    expect(staysInLiquidityBand(start, sqrt(46020).subn(1), 46069, 60)).toBe(false);
  });
  it("keeps the old one-tick behaviour on spacing-1 pools", () => {
    const s = mid(10, 11);
    expect(staysInLiquidityBand(s, mid(10, 11).addn(1), 10, 1)).toBe(true);
    expect(staysInLiquidityBand(s, sqrt(11), 10, 1)).toBe(false);
  });
});
