import { describe, expect, it } from "vitest";
import { amountsPerLiquidity, liquidityForCapital, usdPerLiquidity } from "./clmm-liquidity";
import { estimateRangeApr, type AprBin, type RangeAprInputs } from "./range-apr";
import { sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";

const FEE = 0.0005;
const LP = 0.84;

function bins(from: number, to: number, liquidity: number, volumeByTick: Record<number, number> = {}): AprBin[] {
  const out: AprBin[] = [];
  for (let tick = from; tick < to; tick++) out.push({ tick, liquidity, volumeUsd: volumeByTick[tick] ?? 0 });
  return out;
}

function inputs(patch: Partial<RangeAprInputs> = {}): RangeAprInputs {
  return {
    tickSpacing: 1,
    bins: bins(-6, 6, 1e9, { 0: 1000 }),
    currentSqrt: 1, // tick 0
    usdPerRawB: 1,
    feeRate: FEE,
    lpFeeFraction: LP,
    avgDailyVolumeUsd: 1000,
    capitalUsd: 100,
    ...patch,
  };
}

/** Independent closed form for the +-2 tick band at the current price (tick 0, sqrt 1, $1 per raw B). */
function expectedAprForBand(lowerTick: number, upperTick: number, capital: number, bin: { liquidity: number; volume: number }) {
  const sa = Math.pow(1.0001, lowerTick / 2);
  const sb = Math.pow(1.0001, upperTick / 2);
  const valuePerL = (1 / 1 - 1 / sb) * 1 * 1 + (1 - sa); // a * P + b with P = 1
  const mine = capital / valuePerL;
  const fees = bin.volume * FEE * LP * (mine / (bin.liquidity + mine));
  return (fees * 365 / capital) * 100;
}

describe("CLMM liquidity sizing", () => {
  it("splits a two-sided range into A and B amounts per unit of liquidity", () => {
    const sa = sqrtPriceAtTick(-2);
    const sb = sqrtPriceAtTick(2);
    const { a, b } = amountsPerLiquidity(1, sa, sb);
    expect(a).toBeCloseTo(1 - 1 / sb, 12);
    expect(b).toBeCloseTo(1 - sa, 12);
  });

  it("is single sided when the price is outside the range", () => {
    const sa = sqrtPriceAtTick(10);
    const sb = sqrtPriceAtTick(20);
    expect(amountsPerLiquidity(1, sa, sb)).toEqual({ a: 1 / sa - 1 / sb, b: 0 });
    expect(amountsPerLiquidity(2, sa, sb)).toEqual({ a: 0, b: sb - sa });
  });

  it("buys more liquidity per dollar in a narrower range", () => {
    const wide = liquidityForCapital(100, 1, sqrtPriceAtTick(-100), sqrtPriceAtTick(100), 1);
    const narrow = liquidityForCapital(100, 1, sqrtPriceAtTick(-2), sqrtPriceAtTick(2), 1);
    expect(narrow / wide).toBeGreaterThan(30);
    expect(usdPerLiquidity(1, sqrtPriceAtTick(-2), sqrtPriceAtTick(2), 1) * narrow).toBeCloseTo(100, 8);
  });

  it("returns zero for unusable inputs and rejects broken bounds", () => {
    expect(liquidityForCapital(0, 1, 0.9, 1.1, 1)).toBe(0);
    expect(liquidityForCapital(100, 1, 0.9, 1.1, 0)).toBe(0);
    expect(() => amountsPerLiquidity(1, 1.1, 1.0)).toThrow("Invalid sqrt price bounds");
  });
});

describe("estimateRangeApr", () => {
  it("matches the closed form for a band with all volume in the current bin", () => {
    const result = estimateRangeApr(inputs(), { tickLower: -2, tickUpper: 2 });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.aprPct).toBeCloseTo(expectedAprForBand(-2, 2, 100, { liquidity: 1e9, volume: 1000 }), 6);
    expect(result.inRangeVolumePct).toBe(100);
    expect(result.feesPerDayUsd).toBeCloseTo(result.aprPct / 100 * 100 / 365, 9);
  });

  it("earns the whole LP fee when nobody else has liquidity in the bin", () => {
    const result = estimateRangeApr(inputs({ bins: bins(-6, 6, 0, { 0: 1000 }) }), { tickLower: -2, tickUpper: 2 });
    expect(result.status === "ok" && result.feesPerDayUsd).toBeCloseTo(1000 * FEE * LP, 9);
  });

  it("only counts volume that traded inside the range (in-range fraction)", () => {
    const model = inputs({ bins: bins(-6, 6, 1e9, { 0: 600, 4: 400 }) });
    const inside = estimateRangeApr(model, { tickLower: -2, tickUpper: 2 });
    const wide = estimateRangeApr(model, { tickLower: -6, tickUpper: 6 });
    expect(inside.status === "ok" && inside.inRangeVolumePct).toBeCloseTo(60, 9);
    expect(wide.status === "ok" && wide.inRangeVolumePct).toBeCloseTo(100, 9);
  });

  it("returns 0% (not unavailable) when there was no recent volume", () => {
    const result = estimateRangeApr(inputs({ bins: bins(-6, 6, 1e9), avgDailyVolumeUsd: 0 }), { tickLower: -2, tickUpper: 2 });
    expect(result).toEqual({ status: "ok", aprPct: 0, inRangeVolumePct: 0, feesPerDayUsd: 0 });
  });

  it("ranks a narrow band above a wide one when volume sits at the centre, and dilutes with deposit size", () => {
    const narrow = estimateRangeApr(inputs(), { tickLower: -1, tickUpper: 1 });
    const wide = estimateRangeApr(inputs(), { tickLower: -5, tickUpper: 5 });
    expect(narrow.status === "ok" && wide.status === "ok" && narrow.aprPct > wide.aprPct).toBe(true);
    const small = estimateRangeApr(inputs({ capitalUsd: 10 }), { tickLower: -2, tickUpper: 2 });
    const big = estimateRangeApr(inputs({ capitalUsd: 1e9 }), { tickLower: -2, tickUpper: 2 });
    expect(small.status === "ok" && big.status === "ok" && small.aprPct > big.aprPct).toBe(true);
  });

  it("works with tick spacing > 1 (bins are spacing wide)", () => {
    const wideBins: AprBin[] = [-120, -60, 0, 60].map((tick) => ({ tick, liquidity: 1e9, volumeUsd: tick === 0 ? 1000 : 0 }));
    const result = estimateRangeApr(inputs({ tickSpacing: 60, bins: wideBins }), { tickLower: -120, tickUpper: 120 });
    expect(result.status).toBe("ok");
    expect(estimateRangeApr(inputs({ tickSpacing: 60, bins: wideBins }), { tickLower: -30, tickUpper: 60 }))
      .toEqual({ status: "unavailable", reason: "invalid-range" });
  });

  it("reports why an estimate is unavailable", () => {
    expect(estimateRangeApr(inputs(), { tickLower: 2, tickUpper: -2 })).toEqual({ status: "unavailable", reason: "invalid-range" });
    expect(estimateRangeApr(inputs(), { tickLower: 1.5, tickUpper: 3 })).toEqual({ status: "unavailable", reason: "invalid-range" });
    expect(estimateRangeApr(inputs(), { tickLower: -2, tickUpper: 40 })).toEqual({ status: "unavailable", reason: "range-outside-window" });
    expect(estimateRangeApr(inputs({ bins: [] }), { tickLower: -2, tickUpper: 2 })).toEqual({ status: "unavailable", reason: "range-outside-window" });
    expect(estimateRangeApr(inputs({ usdPerRawB: 0 }), { tickLower: -2, tickUpper: 2 })).toEqual({ status: "unavailable", reason: "no-price" });
    expect(estimateRangeApr(inputs({ currentSqrt: 0 }), { tickLower: -2, tickUpper: 2 })).toEqual({ status: "unavailable", reason: "no-price" });
    expect(estimateRangeApr(inputs({ capitalUsd: 0 }), { tickLower: -2, tickUpper: 2 })).toEqual({ status: "unavailable", reason: "no-capital" });
  });

  it("handles a range entirely above the current price (single sided, earns only if volume reaches it)", () => {
    const above = estimateRangeApr(inputs({ bins: bins(-6, 12, 1e9, { 0: 800, 4: 200 }) }), { tickLower: 3, tickUpper: 6 });
    expect(above.status === "ok" && above.inRangeVolumePct).toBeCloseTo(20, 9);
    expect(above.status === "ok" && above.aprPct).toBeGreaterThan(0);
  });
});
