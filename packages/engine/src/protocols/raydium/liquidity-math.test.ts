import { LiquidityMathUtil, SqrtPriceMath, TickUtil } from "@raydium-io/raydium-sdk-v2";
import { describe, expect, it } from "vitest";
import { LiquidityMathUtil as SharedLiquidity, SqrtPriceMath as SharedSqrt, TickUtil as SharedTick } from "./liquidity-math";

describe("Raydium liquidity math", () => {
  it("re-exports the SDK functions without wrapping them", () => {
    expect(SharedLiquidity).toBe(LiquidityMathUtil);
    expect(SharedSqrt).toBe(SqrtPriceMath);
    expect(SharedTick).toBe(TickUtil);
  });
});
