import { describe, expect, it } from "vitest";
import { sameAssetUsdPerShare } from "./pool-share-price";

// Raydium API v3 rows captured 2026-11-21 12:3x Taipei (/workspace/x3-valuation/ray.json, design §0).
describe("sameAssetUsdPerShare (SP-2)", () => {
  it("counts real shares: SNDK/SNDKx with both sides ×8 is ~$81 a share, not ~$650 per raw token", () => {
    const result = sameAssetUsdPerShare({ tvlUsd: 5556.72, sides: [{ amount: 5.660742, multiplier: 8 }, { amount: 2.8931764, multiplier: 8 }] });
    expect(result.kind).toBe("known");
    expect(result.kind === "known" && result.usdPerShare).toBeCloseTo(81.2, 1);
  });

  it("is TVL over shares when both multipliers are 1 (USDC/USDT ≈ $1)", () => {
    const result = sameAssetUsdPerShare({ tvlUsd: 1_742_775.41, sides: [{ amount: 372_503.461919, multiplier: 1 }, { amount: 1_372_480.580021, multiplier: 1 }] });
    expect(result.kind === "known" && result.usdPerShare).toBeCloseTo(0.9988, 3);
  });

  it("never treats an unknown multiplier as 1", () => {
    expect(sameAssetUsdPerShare({ tvlUsd: 5556.72, sides: [{ amount: 5.66, multiplier: null }, { amount: 2.89, multiplier: 8 }] }))
      .toEqual({ kind: "unknown", reason: "multiplier-unknown" });
  });

  it("is unknown without a TVL, with empty reserves or with bad input", () => {
    expect(sameAssetUsdPerShare({ tvlUsd: null, sides: [{ amount: 1, multiplier: 1 }, { amount: 1, multiplier: 1 }] }).kind).toBe("unknown");
    expect(sameAssetUsdPerShare({ tvlUsd: 0, sides: [{ amount: 1, multiplier: 1 }, { amount: 1, multiplier: 1 }] }).kind).toBe("unknown");
    expect(sameAssetUsdPerShare({ tvlUsd: 10, sides: [{ amount: 0, multiplier: 1 }, { amount: 0, multiplier: 1 }] }))
      .toEqual({ kind: "unknown", reason: "no-reserves" });
    expect(sameAssetUsdPerShare({ tvlUsd: 10, sides: [{ amount: Number.NaN, multiplier: 1 }, { amount: 1, multiplier: 1 }] }))
      .toEqual({ kind: "unknown", reason: "invalid-input" });
    expect(sameAssetUsdPerShare({ tvlUsd: 10, sides: [{ amount: 1, multiplier: 0 }, { amount: 1, multiplier: 1 }] }))
      .toEqual({ kind: "unknown", reason: "multiplier-unknown" });
  });
});

  it("counts SOL-equivalent shares with the official SOL-per-hSOL rate, not 1 hSOL = 1 SOL", () => {
    const rate = 1.19785;
    const result = sameAssetUsdPerShare({
      tvlUsd: 96_580,
      sides: [
        { amount: 502.99, multiplier: 1, underlyingPerToken: 1 },
        { amount: 795.62, multiplier: 1, underlyingPerToken: rate },
      ],
    });
    expect(result.kind).toBe("known");
    const shares = 502.99 + 795.62 * rate;
    expect(result.kind === "known" && result.usdPerShare).toBeCloseTo(96_580 / shares, 6);
    const naive = sameAssetUsdPerShare({
      tvlUsd: 96_580,
      sides: [{ amount: 502.99, multiplier: 1 }, { amount: 795.62, multiplier: 1 }],
    });
    if (result.kind !== "known" || naive.kind !== "known") throw new Error("expected known prices");
    expect(result.usdPerShare).not.toBeCloseTo(naive.usdPerShare, 2);
  });

  it("is unknown when an LST underlying rate is missing", () => {
    expect(sameAssetUsdPerShare({
      tvlUsd: 96_580,
      sides: [{ amount: 502.99, multiplier: 1, underlyingPerToken: 1 }, { amount: 795.62, multiplier: 1, underlyingPerToken: null }],
    })).toEqual({ kind: "unknown", reason: "multiplier-unknown" });
  });
