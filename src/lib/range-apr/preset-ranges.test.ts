import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { RANGE_APR_PRESET_ORDER, resolvePresetRanges } from "./preset-ranges";

const pool = (tickCurrent: number, tickSpacing: number, decimalsA = 6, decimalsB = 6) => ({
  tickCurrent, tickSpacing, decimalsA, decimalsB, sqrtPriceX64: TickUtil.getSqrtPriceAtTick(tickCurrent).toString(),
});

describe("resolvePresetRanges", () => {
  it("returns AI pick first, then tight, standard, wide", () => {
    expect(RANGE_APR_PRESET_ORDER).toEqual(["ai", "tight", "standard", "wide"]);
    expect(resolvePresetRanges(pool(0, 1)).map((range) => range.id)).toEqual(["ai", "tight", "standard", "wide"]);
  });

  it("uses the same tick resolution as the quote path, aligned to the pool's spacing", () => {
    for (const spacing of [1, 10, 60]) {
      for (const range of resolvePresetRanges(pool(-46_068, spacing, 8, 6))) {
        expect(Math.abs(range.tickLower % spacing)).toBe(0);
        expect(Math.abs(range.tickUpper % spacing)).toBe(0);
        expect(range.tickLower).toBeLessThan(range.tickUpper);
        expect(range.priceLower).toBeLessThan(range.priceUpper);
      }
    }
  });

  it("gives the AI pick the documented +-2 spacing band", () => {
    const [ai] = resolvePresetRanges(pool(-46_068, 60));
    expect([ai!.tickLower, ai!.tickUpper]).toEqual([-46_200, -45_960]);
    const [ai1] = resolvePresetRanges(pool(46_080, 1, 6, 8));
    expect([ai1!.tickLower, ai1!.tickUpper]).toEqual([46_078, 46_082]);
  });

  it("orders the percent presets by width", () => {
    const [, tight, standard, wide] = resolvePresetRanges(pool(0, 1));
    const width = (range: { tickLower: number; tickUpper: number }) => range.tickUpper - range.tickLower;
    expect(width(tight!)).toBeLessThan(width(standard!));
    expect(width(standard!)).toBeLessThan(width(wide!));
  });
});
