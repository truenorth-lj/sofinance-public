import { describe, expect, it } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { uiPriceBPerAFromTick } from "./position-performance-math";
import {
  alignTickDown, alignTickUp, rangeInputFromFields, resolveOpenRange, ticksFromUiPriceBand,
} from "./open-range";

describe("open-position range / tick math", () => {
  it("aligns ticks down and up to spacing", () => {
    expect(alignTickDown(37, 10)).toBe(30);
    expect(alignTickUp(37, 10)).toBe(40);
    expect(alignTickUp(40, 10)).toBe(40);
    expect(alignTickDown(-37, 10)).toBe(-40);
  });

  it("builds a tick-aligned band around price 1.0 (B per A) that contains the current price", () => {
    const current = 1;
    const ticks = ticksFromUiPriceBand(current * 0.99, current * 1.01, 6, 6, 1);
    expect(ticks.tickLower).toBeLessThan(ticks.tickUpper);
    expect(Number.isInteger(ticks.tickLower)).toBe(true);
    expect(Number.isInteger(ticks.tickUpper)).toBe(true);
    const lower = uiPriceBPerAFromTick(ticks.tickLower, 6, 6);
    const upper = uiPriceBPerAFromTick(ticks.tickUpper, 6, 6);
    expect(lower).toBeLessThan(current);
    expect(upper).toBeGreaterThan(current);
    expect(TickUtil.toTickIndex(ticks.tickLower, 1)).toBe(ticks.tickLower);
    expect(TickUtil.toTickIndex(ticks.tickUpper, 1)).toBe(ticks.tickUpper);
  });

  it("expands a collapsed custom range to at least one tick spacing", () => {
    const ticks = ticksFromUiPriceBand(1.0000001, 1.0000002, 6, 6, 10);
    expect(ticks.tickUpper - ticks.tickLower).toBeGreaterThanOrEqual(10);
  });

  it("resolves standard preset as in-range around the current tick", () => {
    const tickCurrent = 0;
    const sqrt = TickUtil.getSqrtPriceAtTick(tickCurrent).toString();
    const resolved = resolveOpenRange({
      range: { preset: "standard" },
      currentPrice: uiPriceBPerAFromTick(tickCurrent, 6, 6),
      tickCurrent,
      sqrtPriceX64: sqrt,
      decimalsA: 6,
      decimalsB: 6,
      tickSpacing: 1,
    });
    expect(resolved.rangeSide).toBe("inside");
    expect(resolved.inRange).toBe(true);
    expect(resolved.tickLower).toBeLessThan(tickCurrent);
    expect(resolved.tickUpper).toBeGreaterThan(tickCurrent);
    expect(resolved.narrow).toBe(false);
  });

  it("marks tight preset as narrow with an out-of-range warning", () => {
    const tickCurrent = 0;
    const resolved = resolveOpenRange({
      range: { preset: "tight" },
      currentPrice: uiPriceBPerAFromTick(tickCurrent, 6, 6),
      tickCurrent,
      sqrtPriceX64: TickUtil.getSqrtPriceAtTick(tickCurrent).toString(),
      decimalsA: 6,
      decimalsB: 6,
      tickSpacing: 1,
    });
    expect(resolved.narrow).toBe(true);
    expect(resolved.warning).toMatch(/out of range/i);
  });

  it("requires custom min/max prices", () => {
    expect(() => rangeInputFromFields("custom")).toThrow(/minPrice and maxPrice/);
    expect(rangeInputFromFields("wide")).toEqual({ preset: "wide" });
  });

  it("marks a custom band entirely above the current price as out of range", () => {
    const resolved = resolveOpenRange({
      range: { preset: "custom", minPrice: "2", maxPrice: "3" },
      currentPrice: 1,
      tickCurrent: 0,
      sqrtPriceX64: TickUtil.getSqrtPriceAtTick(0).toString(),
      decimalsA: 6,
      decimalsB: 6,
      tickSpacing: 1,
    });
    expect(resolved.inRange).toBe(false);
    expect(resolved.rangeSide).toBe("below");
  });

  describe("ai preset (centred +-2 tick-spacing units)", () => {
    const resolveAi = (tickCurrent: number, tickSpacing: number, fraction = 0, decimals: [number, number] = [6, 6]) => {
      const sqrt = TickUtil.getSqrtPriceAtTick(tickCurrent);
      // nudge the price a fraction of a tick above the boundary
      const nudged = fraction ? sqrt.muln(1_000_000_000 + Math.round(fraction * 0.5 * 1e5)).divn(1_000_000_000) : sqrt;
      return resolveOpenRange({
        range: { preset: "ai" },
        currentPrice: uiPriceBPerAFromTick(tickCurrent, decimals[0], decimals[1]),
        tickCurrent,
        sqrtPriceX64: nudged.toString(),
        decimalsA: decimals[0], decimalsB: decimals[1], tickSpacing,
      });
    };

    it("is 4 spacing units wide, aligned, and straddles the current price for several spacings", () => {
      for (const spacing of [1, 10, 60, 120]) {
        for (const tick of [-46_080, -46_068, -1, 0, 1, 46_080, 46_093]) {
          const aligned = Math.floor(tick / spacing) * spacing;
          const resolved = resolveAi(tick, spacing);
          expect(resolved.tickUpper - resolved.tickLower).toBe(4 * spacing);
          expect(Math.abs(resolved.tickLower % spacing)).toBe(0);
          expect(resolved.tickLower).toBeLessThan(tick);
          expect(resolved.tickUpper).toBeGreaterThan(tick);
          expect(resolved.rangeSide).toBe("inside");
          expect(Math.abs(aligned + spacing / 2 - (resolved.tickLower + resolved.tickUpper) / 2)).toBeLessThanOrEqual(spacing / 2 + spacing);
        }
      }
    });

    it("centres on the nearest boundary of the exact price (spacing 60, negative ticks)", () => {
      // tickCurrent -46068 is 12 above boundary -46080 and 48 below -46020
      const resolved = resolveAi(-46_068, 60);
      expect([resolved.tickLower, resolved.tickUpper]).toEqual([-46_200, -45_960]);
      expect(resolved.preset).toBe("ai");
    });

    it("flags only genuinely narrow bands (<= 10 raw ticks) with the narrow warning", () => {
      expect(resolveAi(0, 1).narrow).toBe(true);
      expect(resolveAi(0, 1).warning).toMatch(/out of range/i);
      expect(resolveAi(0, 10).narrow).toBe(false);
      expect(resolveAi(0, 60).warning).toBeNull();
    });

    it("reports prices for the aligned ticks, using each pool's decimals", () => {
      const resolved = resolveAi(46_080, 1, 0, [6, 8]);
      expect(resolved.priceLower).toBeCloseTo(uiPriceBPerAFromTick(46_078, 6, 8), 12);
      expect(resolved.priceUpper).toBeCloseTo(uiPriceBPerAFromTick(46_082, 6, 8), 12);
      expect(resolved.requestedMinPrice).toBeCloseTo(resolved.priceLower, 12);
    });

    it("leaves the percent presets unchanged", () => {
      const sqrt = TickUtil.getSqrtPriceAtTick(0).toString();
      const standard = resolveOpenRange({
        range: { preset: "standard" }, currentPrice: 1, tickCurrent: 0, sqrtPriceX64: sqrt, decimalsA: 6, decimalsB: 6, tickSpacing: 1,
      });
      expect([standard.tickLower, standard.tickUpper]).toEqual([-31, 29]);
    });

    it("is accepted by rangeInputFromFields", () => {
      expect(rangeInputFromFields("ai")).toEqual({ preset: "ai" });
    });
  });
});
