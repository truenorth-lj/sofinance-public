import { describe, expect, it } from "vitest";
import { scaledUiTvlUsd } from "./pool-tvl";

// Meteora NVDA/NVDAx (Aq7nhS8p…), datapi /pools/{address} captured 2026-11-21 12:3x Taipei (design §0, P2):
// NVDA (X) has no multiplier; NVDAx (Y) is ×1.001701196801074 on chain.
const NVDA = {
  sourceTvlUsd: 39_347.15291483027,
  x: { amount: 90.630577, sharePriceUsd: 127.40917157110418 },
  y: { amount: 218.226743296602, sharePriceUsd: 127.61290212453196 },
  multiplierY: 1.001701196801074,
};

describe("scaledUiTvlUsd (X3-7)", () => {
  it("adds only the missing multiplier part: NVDA/NVDAx is ~$47 low on ~$39.3k (design P2)", () => {
    const result = scaledUiTvlUsd({ sourceTvlUsd: NVDA.sourceTvlUsd, sides: [
      { ...NVDA.x, multiplier: 1 }, { ...NVDA.y, multiplier: NVDA.multiplierY }] });
    const missing = NVDA.y.amount * (NVDA.multiplierY - 1) * NVDA.y.sharePriceUsd;
    expect(result).toEqual({ kind: "corrected", tvlUsd: NVDA.sourceTvlUsd + missing, sourceTvlUsd: NVDA.sourceTvlUsd });
    expect(missing).toBeCloseTo(47.38, 2);
    expect((result.tvlUsd / NVDA.sourceTvlUsd - 1) * 100).toBeCloseTo(0.12, 2);
  });
  it("leaves a pool with no multiplier unchanged, even when the source has no prices", () => {
    expect(scaledUiTvlUsd({ sourceTvlUsd: 1_000, sides: [
      { amount: 5, sharePriceUsd: null, multiplier: 1 }, { amount: 7, sharePriceUsd: null, multiplier: 1 }] }))
      .toEqual({ kind: "corrected", tvlUsd: 1_000, sourceTvlUsd: 1_000 });
  });
  it("applies a ×8 multiplier on both sides (SNDK-like) and a multiplier below 1 (reverse split) the same way", () => {
    expect(scaledUiTvlUsd({ sourceTvlUsd: 679, sides: [
      { amount: 2, sharePriceUsd: 78.63, multiplier: 8 }, { amount: 6.6, sharePriceUsd: 79, multiplier: 8 }] }).tvlUsd)
      .toBeCloseTo(679 + 2 * 7 * 78.63 + 6.6 * 7 * 79, 9);
    expect(scaledUiTvlUsd({ sourceTvlUsd: 200, sides: [
      { amount: 1, sharePriceUsd: 100, multiplier: 0.5 }, { amount: 1, sharePriceUsd: 100, multiplier: 1 }] }).tvlUsd).toBeCloseTo(150, 9);
  });
  it("never treats an unknown multiplier as 1: keeps the published figure and says why", () => {
    for (const multiplier of [null, 0, Number.NaN, -1]) {
      expect(scaledUiTvlUsd({ sourceTvlUsd: NVDA.sourceTvlUsd, sides: [{ ...NVDA.x, multiplier: 1 }, { ...NVDA.y, multiplier }] }))
        .toEqual({ kind: "unverified", tvlUsd: NVDA.sourceTvlUsd, sourceTvlUsd: NVDA.sourceTvlUsd, reason: "multiplier-unknown" });
    }
  });
  it("a scaled side without a usable price is unverified (never valued at a guess)", () => {
    for (const sharePriceUsd of [null, 0, Number.NaN]) {
      expect(scaledUiTvlUsd({ sourceTvlUsd: 100, sides: [{ ...NVDA.x, multiplier: 1 }, { ...NVDA.y, sharePriceUsd, multiplier: NVDA.multiplierY }] }))
        .toMatchObject({ kind: "unverified", tvlUsd: 100, reason: "unpriced" });
    }
    // An empty scaled side needs no price.
    expect(scaledUiTvlUsd({ sourceTvlUsd: 100, sides: [{ ...NVDA.x, multiplier: 1 }, { amount: 0, sharePriceUsd: null, multiplier: 8 }] }).kind).toBe("corrected");
  });
  it("rejects unusable inputs", () => {
    expect(scaledUiTvlUsd({ sourceTvlUsd: Number.NaN, sides: [{ ...NVDA.x, multiplier: 1 }, { ...NVDA.y, multiplier: 1 }] }).kind).toBe("unverified");
    expect(scaledUiTvlUsd({ sourceTvlUsd: 100, sides: [{ amount: -1, sharePriceUsd: 1, multiplier: 1 }, { ...NVDA.y, multiplier: 1 }] }))
      .toMatchObject({ kind: "unverified", reason: "invalid-input" });
  });
});
