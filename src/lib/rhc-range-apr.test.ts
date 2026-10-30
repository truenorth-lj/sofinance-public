import { describe, expect, it } from "vitest";
import { resolveRhcPresetRanges, sqrtPriceX96ToX64 } from "./rhc-range-apr-presets";

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
