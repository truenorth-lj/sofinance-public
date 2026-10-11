import Decimal from "decimal.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import {
  binIndexOfTick, ceilToSpacing, exactTickFromSqrtPriceX64, exactTickFromUiPrice, floorToSpacing,
  sqrtPriceAtTick, sqrtPriceX64ToNumber, uiPriceFromTick, usableTickBounds,
} from "./tick-math";

describe("spacing alignment", () => {
  it("floors and ceils correctly for negative and positive ticks", () => {
    expect(floorToSpacing(37, 10)).toBe(30);
    expect(floorToSpacing(-37, 10)).toBe(-40);
    expect(ceilToSpacing(37, 10)).toBe(40);
    expect(ceilToSpacing(-37, 10)).toBe(-30);
    expect(floorToSpacing(60, 60)).toBe(60);
    expect(ceilToSpacing(-60, 60)).toBe(-60);
    expect(Object.is(floorToSpacing(0, 60), 0)).toBe(true);
    expect(Object.is(ceilToSpacing(-0.5, 60), 0)).toBe(true);
  });

  it("indexes bins with floor division", () => {
    expect(binIndexOfTick(-1, 60)).toBe(-1);
    expect(binIndexOfTick(0, 60)).toBe(0);
    expect(binIndexOfTick(59, 60)).toBe(0);
    expect(binIndexOfTick(60, 60)).toBe(1);
    expect(binIndexOfTick(-61, 60)).toBe(-2);
  });

  it("rejects invalid spacing", () => {
    expect(() => floorToSpacing(1, 0)).toThrow("Invalid pool tick spacing");
    expect(() => ceilToSpacing(1, 1.5)).toThrow("Invalid pool tick spacing");
  });

  it("returns usable bounds that are multiples of the spacing", () => {
    for (const spacing of [1, 10, 60, 120]) {
      const { min, max } = usableTickBounds(spacing);
      expect(Math.abs(min % spacing)).toBe(0);
      expect(Math.abs(max % spacing)).toBe(0);
      expect(min).toBeGreaterThanOrEqual(-443636);
      expect(max).toBeLessThanOrEqual(443636);
    }
  });
});

describe("parity with the Raydium SDK", () => {
  const ticks = [-443636, -120_000, -46_080, -1, 0, 1, 46_080, 46_081, 120_000, 443_635];

  it("sqrtPriceAtTick matches TickUtil.getSqrtPriceAtTick to float precision", () => {
    for (const tick of ticks) {
      const sdk = sqrtPriceX64ToNumber(TickUtil.getSqrtPriceAtTick(tick).toString());
      expect(Math.abs(sqrtPriceAtTick(tick) - sdk) / sdk).toBeLessThan(1e-9);
    }
  });

  it("the exact tick of a pool sqrt price floors to the SDK tick index", () => {
    for (const tick of ticks) {
      const sqrt = TickUtil.getSqrtPriceAtTick(tick);
      const exact = exactTickFromSqrtPriceX64(sqrt.toString());
      // The SDK truncates sqrtPriceX64 at integer ticks, so the exact tick can sit a hair below the integer.
      expect(Math.abs(exact - tick)).toBeLessThan(1e-4);
      expect(Math.floor(exact + 1e-4)).toBe(TickUtil.getTickAtSqrtPrice(sqrt));
    }
  });

  it("exactTickFromUiPrice floors to the SDK tick for several decimal pairs", () => {
    for (const [price, decimalsA, decimalsB] of [[1.0026, 6, 8], [0.9986, 8, 6], [1, 6, 6], [1.0001, 9, 6], [0.9912, 6, 6]] as const) {
      const sdkTick = TickUtil.getTickAtSqrtPrice(TickUtil.priceToSqrtPriceX64(new Decimal(price), decimalsA, decimalsB));
      const exact = exactTickFromUiPrice(price, decimalsA, decimalsB);
      expect(Math.floor(exact)).toBe(sdkTick);
      expect(Math.abs(uiPriceFromTick(exact, decimalsA, decimalsB) - price) / price).toBeLessThan(1e-9);
    }
  });

  it("rejects non-positive prices and sqrt prices", () => {
    expect(() => exactTickFromUiPrice(0, 6, 6)).toThrow();
    expect(() => exactTickFromSqrtPriceX64("0")).toThrow();
  });
});
