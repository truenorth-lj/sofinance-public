import { describe, expect, it } from "vitest";
import { formatSolCost } from "./sol-cost";

describe("SOL cost in USDC", () => {
  it("preserves a small transaction fee instead of rounding it to zero", () => {
    expect(formatSolCost(5000, 150)).toBe("0.000005 SOL (≈ 0.00075 USDC)");
  });
  it("converts rent and combined upfront costs", () => {
    expect(formatSolCost(6156960, 150)).toBe("0.00615696 SOL (≈ 0.9235 USDC)");
    expect(formatSolCost(6161960, 150)).toBe("0.00616196 SOL (≈ 0.9243 USDC)");
  });
  it("distinguishes zero from unavailable and very small estimates", () => {
    expect(formatSolCost(0, 150)).toBe("0 SOL (≈ 0 USDC)");
    expect(formatSolCost(1, 150)).toBe("0.000000001 SOL (≈ < 0.000001 USDC)");
    for (const rate of [null, 0, -1, NaN, Infinity]) {
      expect(formatSolCost(5000, rate)).toBe("0.000005 SOL (USDC estimate unavailable)");
    }
  });
});
