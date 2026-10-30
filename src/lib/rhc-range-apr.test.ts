import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import { usdPerRawTokenB } from "./range-apr/build-model";
import { resolveRhcPresetRanges, sqrtPriceX96ToX64 } from "./rhc-range-apr-presets";
import { RHC_TOKEN_PRICE_UNAVAILABLE, rhcEconomics } from "./rhc-range-apr";

describe("rhc range APR helpers", () => {
  it("converts Q96 sqrt price to Q64 by dropping 32 bits", () => {
    const x96 = 79_228_162_514_264_337_593_543_950_336n; // 2^96
    expect(sqrtPriceX96ToX64(x96)).toBe((1n << 64n).toString());
  });

  it("offers ±10 ticks / ±0.3% / ±1% and skips tight", () => {
    const presets = resolveRhcPresetRanges({ tickCurrent: 0, decimalsA: 18, decimalsB: 18, tickSpacing: 1 });
    expect(presets.map((p) => p.id)).toEqual(["micro", "standard", "wide"]);
    expect(presets[0]).toMatchObject({ tickLower: -10, tickUpper: 10 });
    expect(presets[1]).toMatchObject({ tickLower: -30, tickUpper: 30 });
    expect(presets[2]).toMatchObject({ tickLower: -100, tickUpper: 100 });
  });
});

describe("rhcEconomics token pricing", () => {
  const GOOGL = UNIV4_RHC_ALLOWLISTED_POOLS.find((p) => p.currency0.symbol === "GOOGL")!;
  const state = { feePips: { zeroForOne: 50, oneForZero: 50 }, sqrtPriceX96: 1n << 96n, protocolFee: 0 };
  const rawB = (e: ReturnType<typeof rhcEconomics>) => usdPerRawTokenB({
    tvlUsd: e.tvlUsd, mintAmountA: e.mintAmountA, mintAmountB: e.mintAmountB, priceBPerA: e.price, decimalsB: e.decimalsB,
  });

  it("values token B at its USD price, not $1 (regression: GOOGLon ≈ $285 inflated the range APR ~285×)", () => {
    const economics = rhcEconomics(GOOGL, state, 41_715, { token0: 284.72, token1: 285.47 });
    expect(rawB(economics)! * 1e18).toBeCloseTo(285.47, 6);
    expect(economics.mintAmountA * economics.price + economics.mintAmountB).toBeCloseTo(41_715 / 285.47, 6);
    expect(economics.feeRate).toBe(0.00005);
  });

  it("derives token B from token A through the pool price, and refuses to guess without any price", () => {
    const twoX = { ...state, sqrtPriceX96: BigInt(Math.round(Math.SQRT2 * 2 ** 48)) << 48n }; // price ≈ 2 B per A
    expect(rawB(rhcEconomics(GOOGL, twoX, 1_000, { token0: 300, token1: 0 }))! * 1e18).toBeCloseTo(150, 3);
    expect(() => rhcEconomics(GOOGL, state, 1_000, null)).toThrow(RHC_TOKEN_PRICE_UNAVAILABLE);
  });
});
