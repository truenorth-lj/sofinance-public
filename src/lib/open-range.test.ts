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
});
