import { TickArrayUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import {
  TICK_ARRAY_SIZE, buildLiquidityBins, tickArrayStartIndex, tickArrayStartsForWindow, windowBounds,
} from "./liquidity-bins";

describe("tick array indexing (parity with the Raydium SDK)", () => {
  it("matches TickArrayUtil.getTickArrayStartIndex", () => {
    expect(TICK_ARRAY_SIZE).toBe(60);
    for (const spacing of [1, 10, 60]) {
      for (const tick of [-46_081, -46_080, -1, 0, 1, 59, 60, 3_599, 3_600, 46_080]) {
        expect(tickArrayStartIndex(tick, spacing)).toBe(TickArrayUtil.getTickArrayStartIndex(tick, spacing));
      }
    }
  });

  it("lists every array overlapping a window", () => {
    expect(tickArrayStartsForWindow(-100, 100, 1)).toEqual([-120, -60, 0, 60]);
    expect(tickArrayStartsForWindow(0, 59, 1)).toEqual([0]);
    expect(tickArrayStartsForWindow(-360, 360, 60)).toEqual([-3600, 0]);
  });
});

describe("windowBounds", () => {
  it("anchors on the bin that contains the current tick, including negatives", () => {
    expect(windowBounds(-46_068, 60, 2)).toEqual({ currentBin: -768, firstTick: -46_200, endTick: -45_900 });
    expect(windowBounds(5, 1, 3)).toEqual({ currentBin: 5, firstTick: 2, endTick: 9 });
  });
});

describe("buildLiquidityBins", () => {
  it("applies liquidityNet going up and down from the active liquidity", () => {
    // Position A: ticks [-2, 3) with L=100. Position B: ticks [0, 5) with L=50.
    const net = new Map<number, bigint>([[-2, 100n], [3, -100n], [0, 50n], [5, -50n]]);
    const bins = buildLiquidityBins({ tickCurrent: 1, tickSpacing: 1, poolLiquidity: 150n, liquidityNet: net, halfWindowBins: 4 });
    expect(bins.map((bin) => [bin.tick, bin.liquidity])).toEqual([
      [-3, 0], [-2, 100], [-1, 100], [0, 150], [1, 150], [2, 150], [3, 50], [4, 50], [5, 0],
    ]);
  });

  it("works for negative current ticks and spacing > 1", () => {
    // One position over [-120, 60) with L=7 at spacing 60; current tick -46..: use a small example
    const net = new Map<number, bigint>([[-120, 7n], [60, -7n]]);
    const bins = buildLiquidityBins({ tickCurrent: -30, tickSpacing: 60, poolLiquidity: 7n, liquidityNet: net, halfWindowBins: 3 });
    expect(bins.map((bin) => [bin.tick, bin.liquidity])).toEqual([
      [-240, 0], [-180, 0], [-120, 7], [-60, 7], [0, 7], [60, 0], [120, 0],
    ]);
  });

  it("returns a single flat profile when there are no initialised ticks nearby and never goes negative", () => {
    const flat = buildLiquidityBins({ tickCurrent: 0, tickSpacing: 1, poolLiquidity: 9n, liquidityNet: new Map(), halfWindowBins: 2 });
    expect(flat.map((bin) => bin.liquidity)).toEqual([9, 9, 9, 9, 9]);
    const odd = buildLiquidityBins({ tickCurrent: 0, tickSpacing: 1, poolLiquidity: 1n, liquidityNet: new Map([[1, -5n]]), halfWindowBins: 1 });
    expect(odd.map((bin) => bin.liquidity)).toEqual([1, 1, 0]);
  });
});
