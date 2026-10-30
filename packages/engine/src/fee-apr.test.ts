import { describe, expect, it } from "vitest";
import { feeAprPct, poolFeeAprPct } from "./fee-apr";

describe("fee APR formula", () => {
  it("annualises daily fees over TVL in percent", () => {
    expect(feeAprPct(10, 36_500)).toBeCloseTo(10);
    expect(poolFeeAprPct({ feeRate: 0.0025, dailyVolumeUsd: 4_000, tvlUsd: 36_500 })).toBeCloseTo(10);
    expect(poolFeeAprPct({ feeRate: 0.0025, dailyVolumeUsd: 4_000, tvlUsd: 36_500, lpFeeFraction: 0.5 })).toBeCloseTo(5);
  });

  it("is null for missing, negative or zero inputs", () => {
    expect(feeAprPct(1, 0)).toBeNull();
    expect(feeAprPct(-1, 10)).toBeNull();
    expect(feeAprPct(Number.NaN, 10)).toBeNull();
    expect(poolFeeAprPct({ feeRate: -0.1, dailyVolumeUsd: 1, tvlUsd: 1 })).toBeNull();
  });

  it("matches the previous inline formulas bit for bit", () => {
    for (const [feeRate, volume, tvl] of [[0.0005, 123_456.789, 98_765.4321], [0.000_050_5, 7_777.77, 1_234_567.89], [0.01, 0.3, 0.7]] as const) {
      expect(poolFeeAprPct({ feeRate, dailyVolumeUsd: volume, tvlUsd: tvl })).toBe((feeRate * volume / tvl) * 365 * 100);
      expect(feeAprPct(volume * feeRate, tvl)).toBe(((volume * feeRate) / tvl) * 365 * 100);
    }
  });
});
