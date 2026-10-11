import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import {
  MICRO_HALF_WIDTH_SPACINGS, microRange, microRangeFromExactTick, nearestBoundary,
} from "./micro-range";
import { usableTickBounds } from "./tick-math";

describe("nearestBoundary", () => {
  it("rounds to the closest valid boundary, ties to the lower one", () => {
    expect(nearestBoundary(46_080.4, 1)).toBe(46_080);
    expect(nearestBoundary(46_080.6, 1)).toBe(46_081);
    expect(nearestBoundary(46_080.5, 1)).toBe(46_080);
    expect(nearestBoundary(-46_068.2, 60)).toBe(-46_080); // -46080 is 11.8 away, -46020 is 48.2 away
    expect(nearestBoundary(-46_049.9, 60)).toBe(-46_020);
    expect(nearestBoundary(-46_050, 60)).toBe(-46_080); // exact tie -> lower
    expect(nearestBoundary(30.1, 60)).toBe(60);
    expect(nearestBoundary(30, 60)).toBe(0);
  });
});

describe("Micro range: centred, +-2 tick-spacing units (4 wide)", () => {
  it("is exactly 4 spacing units wide and aligned for several spacings", () => {
    expect(MICRO_HALF_WIDTH_SPACINGS).toBe(2);
    for (const spacing of [1, 5, 10, 60, 120, 200]) {
      for (const tick of [-46_068.3, -1.2, -0.4, 0, 0.4, 17.5, 46_080.46, 120_001.9]) {
        const range = microRangeFromExactTick(tick, spacing);
        expect(range.tickUpper - range.tickLower).toBe(4 * spacing);
        expect(Math.abs(range.tickLower % spacing)).toBe(0);
        expect(Math.abs(range.tickUpper % spacing)).toBe(0);
        expect(range.centerTick - range.tickLower).toBe(2 * spacing);
      }
    }
  });

  it("keeps the current price strictly inside the band (within half a spacing of the centre)", () => {
    for (const spacing of [1, 10, 60]) {
      for (let tick = -200; tick <= 200; tick += 0.37) {
        const range = microRangeFromExactTick(tick, spacing);
        expect(Math.abs(tick - range.centerTick)).toBeLessThanOrEqual(spacing / 2 + 1e-9);
        expect(tick).toBeGreaterThan(range.tickLower);
        expect(tick).toBeLessThan(range.tickUpper);
      }
    }
  });

  it("matches the documented examples for positive and negative ticks", () => {
    // spacing 1, current exact tick 46080.46 (SPCXx/SPCX): centre 46080 -> [46078, 46082]
    expect(microRangeFromExactTick(46_080.46, 1)).toEqual({ tickLower: 46_078, tickUpper: 46_082, centerTick: 46_080 });
    // spacing 60, tickCurrent -46068 (HOODx/HOOD): centre -46080 -> [-46200, -45960]
    expect(microRangeFromExactTick(-46_068, 60)).toEqual({ tickLower: -46_200, tickUpper: -45_960, centerTick: -46_080 });
    // spacing 10, tickCurrent -46068: centre -46070 -> [-46090, -46050]
    expect(microRangeFromExactTick(-46_068, 10)).toEqual({ tickLower: -46_090, tickUpper: -46_050, centerTick: -46_070 });
    // price exactly on a boundary
    expect(microRangeFromExactTick(0, 60)).toEqual({ tickLower: -120, tickUpper: 120, centerTick: 0 });
    expect(microRangeFromExactTick(-60, 60)).toEqual({ tickLower: -180, tickUpper: 60, centerTick: -60 });
  });

  it("clamps the band into the usable tick range at the extremes", () => {
    const { min, max } = usableTickBounds(60);
    const low = microRangeFromExactTick(-443_500, 60);
    expect(low.tickLower).toBe(min);
    expect(low.tickUpper - low.tickLower).toBe(240);
    expect(low.centerTick).toBe(min + 120);
    const high = microRangeFromExactTick(443_500, 60);
    expect(high.tickUpper).toBe(max);
  });

  it("derives the fractional tick from the pool sqrt price", () => {
    for (const tick of [-46_080, -3, 0, 5, 46_080]) {
      const sqrt = TickUtil.getSqrtPriceAtTick(tick).toString();
      const range = microRange(sqrt, 1);
      expect(range.centerTick).toBe(tick);
      expect(range.tickLower).toBe(tick - 2);
      expect(range.tickUpper).toBe(tick + 2);
    }
    // halfway between two spacing-60 boundaries but a little below the midpoint -> rounds down
    const sqrt = TickUtil.getSqrtPriceAtTick(-46_081).toString();
    expect(microRange(sqrt, 60).centerTick).toBe(-46_080);
  });

  it("rejects invalid spacing and non-finite ticks", () => {
    expect(() => microRangeFromExactTick(1, 0)).toThrow("Invalid pool tick spacing");
    expect(() => microRangeFromExactTick(Number.NaN, 1)).toThrow();
  });
});
