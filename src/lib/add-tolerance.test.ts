import { describe, expect, it } from "vitest";
import { parseAddToleranceBps, toleranceFromPercent } from "./amount";
import { padAmountMax, toleranceLiquidity } from "./quote-math";

describe("add-liquidity price tolerance", () => {
  it("parses the tolerance with a 1% default and a 5% cap", () => {
    expect(parseAddToleranceBps(undefined)).toBe(100);
    expect(parseAddToleranceBps(0)).toBe(0);
    expect(parseAddToleranceBps(500)).toBe(500);
    for (const bad of [-10, 510, 15, 1.5, "100", NaN]) expect(() => parseAddToleranceBps(bad)).toThrow();
  });

  it("converts the UI percent to basis points", () => {
    expect(toleranceFromPercent("1.0")).toBe(100);
    expect(toleranceFromPercent("0")).toBe(0);
    expect(toleranceFromPercent("2.5")).toBe(250);
    expect(toleranceFromPercent("5")).toBe(500);
    for (const bad of ["5.1", "6", "-1", "0.05", "abc"]) expect(() => toleranceFromPercent(bad)).toThrow();
  });

  it("shrinks liquidity by 1 / (1 + tolerance)", () => {
    expect(toleranceLiquidity(1_010_000n, 100)).toBe(1_000_000n);
    expect(toleranceLiquidity(1_000_000n, 0)).toBe(1_000_000n);
    expect(toleranceLiquidity(1_050_000n, 500)).toBe(1_000_000n);
    expect(toleranceLiquidity(1n, 100)).toBe(0n);
  });

  it("pads amountMax by the tolerance, rounding up, capped at the guaranteed swap output", () => {
    expect(padAmountMax(1_000_000n, 2_000_000n, 100)).toBe(1_010_000n);
    expect(padAmountMax(1_000_001n, 2_000_000n, 100)).toBe(1_010_002n);
    expect(padAmountMax(1_000_000n, 1_005_000n, 100)).toBe(1_005_000n);
    expect(padAmountMax(1_000_000n, 1_000_000n, 0)).toBe(1_000_000n);
    expect(padAmountMax(0n, 5n, 100)).toBe(0n);
    expect(() => padAmountMax(2n, 1n, 100)).toThrow();
  });

  it("lets either side grow by the tolerance after shrinking liquidity", () => {
    // amounts scale linearly with liquidity at a fixed price
    const out = 1_000_000_000n;
    const shrunk = toleranceLiquidity(out, 100);
    const max = padAmountMax(shrunk, out, 100);
    expect(max).toBeLessThanOrEqual(out);
    expect(max * 10_000n).toBeGreaterThanOrEqual(shrunk * 10_100n);
  });
});
