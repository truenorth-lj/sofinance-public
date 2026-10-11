import { describe, expect, it } from "vitest";
import { buildAprBins, lpFeeFraction, sampleConfidence, usdPerRawTokenB } from "./build-model";

describe("buildAprBins", () => {
  const liquidity = [{ tick: -2, liquidity: 5 }, { tick: -1, liquidity: 6 }, { tick: 0, liquidity: 7 }];

  it("scales occupancy shares by the average daily volume", () => {
    const bins = buildAprBins(liquidity, { shares: [0.2, 0.3, 0.5], outsideShare: 0 }, 1000, 0, 1);
    expect(bins.map((bin) => bin.volumeUsd)).toEqual([200, 300, 500]);
    expect(bins.map((bin) => bin.liquidity)).toEqual([5, 6, 7]);
  });

  it("falls back to all volume at the current price when there is no price history", () => {
    expect(buildAprBins(liquidity, null, 1000, -1, 1).map((bin) => bin.volumeUsd)).toEqual([0, 1000, 0]);
    const wide = [{ tick: -60, liquidity: 1 }, { tick: 0, liquidity: 1 }];
    expect(buildAprBins(wide, null, 10, -5, 60).map((bin) => bin.volumeUsd)).toEqual([10, 0]);
  });
});

describe("usdPerRawTokenB", () => {
  it("derives the USD value of one raw B unit from TVL and token amounts", () => {
    // 100 A at 2 B per A + 50 B = 250 B-equivalents worth $500 -> $2 per B; B has 6 decimals
    expect(usdPerRawTokenB({ tvlUsd: 500, mintAmountA: 100, mintAmountB: 50, priceBPerA: 2, decimalsB: 6 })).toBeCloseTo(2e-6, 12);
  });

  it("is null for empty pools or missing TVL", () => {
    expect(usdPerRawTokenB({ tvlUsd: 0, mintAmountA: 1, mintAmountB: 1, priceBPerA: 1, decimalsB: 6 })).toBeNull();
    expect(usdPerRawTokenB({ tvlUsd: 10, mintAmountA: 0, mintAmountB: 0, priceBPerA: 1, decimalsB: 6 })).toBeNull();
  });
});

describe("lpFeeFraction", () => {
  it("removes the protocol and fund cuts (parts per million)", () => {
    expect(lpFeeFraction(120_000, 40_000)).toBeCloseTo(0.84, 12);
    expect(lpFeeFraction(0, 0)).toBe(1);
    expect(lpFeeFraction(900_000, 900_000)).toBe(0);
  });

  it("assumes Raydium's standard 12% + 4% when the config is missing", () => {
    expect(lpFeeFraction(null, null)).toBeCloseTo(0.84, 12);
  });
});

describe("sampleConfidence", () => {
  const good = { days: 7, volumeSource: "geckoterminal-daily", occupancySource: "hourly-candles", unplacedVolumePct: 5 } as const;
  it("is ok for a full sample with placed volume", () => expect(sampleConfidence(good)).toBe("ok"));
  it("is low for thin or patchy samples", () => {
    expect(sampleConfidence({ ...good, days: 2 })).toBe("low");
    expect(sampleConfidence({ ...good, volumeSource: "raydium-7d" })).toBe("low");
    expect(sampleConfidence({ ...good, occupancySource: "current-price" })).toBe("low");
    expect(sampleConfidence({ ...good, unplacedVolumePct: 31 })).toBe("low");
  });
});
