import { describe, expect, it } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { resolveOpenRange } from "@sofinance/engine/open-range";
import { uiPriceBPerAFromTick } from "@sofinance/engine/position-performance-math";
import { exactTickFromUiPrice } from "@sofinance/engine/range-apr/tick-math";
import { openRangeCenterPrice, unitBand, unitCenterWithCurrentFallback, tickRangeContainsCurrent } from "./open-range-center";
import { OPEN_RANGE_PRESETS } from "@sofinance/engine/open-range-presets";
import { fairPriceFor } from "./fair-price";

/** Standard (±0.3%) default, the ticks that get signed when the fair-center control is on. */
function standardRange(input: {
  currentPrice: number;
  tickCurrent: number;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  centerPrice?: number;
  centerOnParity?: boolean;
}) {
  const sqrtPriceX64 = TickUtil.getSqrtPriceAtTick(input.tickCurrent).toString();
  const centerOnParity = input.centerOnParity ?? true;
  return resolveOpenRange({
    range: input.centerPrice !== undefined
      ? { preset: "standard", centerOnParity, centerPrice: input.centerPrice }
      : { preset: "standard", centerOnParity },
    currentPrice: input.currentPrice,
    tickCurrent: input.tickCurrent,
    sqrtPriceX64,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    tickSpacing: input.tickSpacing,
  });
}

const NVDA = {
  symbolA: "NVDA", symbolB: "NVDAx",
  multiplierA: 1, multiplierB: 1.001701196801074,
  // on-chain raw Y/X from the Meteora active bin (unit proof)
  onChainPriceBPerA: 0.9987004694792917,
  decimalsA: 6, decimalsB: 8, tickSpacing: 1, tickCurrent: 46041,
};
const SPY = {
  symbolA: "SPY", symbolB: "SPYx",
  multiplierA: 1, multiplierB: 1.007474126658766,
  onChainPriceBPerA: 0.9938644349211665,
  decimalsA: 6, decimalsB: 8, tickSpacing: 10, tickCurrent: 0, // placeholder; tests that need ticks set tickCurrent from price
};
const SNDK = {
  symbolA: "SNDK", symbolB: "SNDKx",
  multiplierA: 8, multiplierB: 8,
  onChainPriceBPerA: 1.0002,
  decimalsA: 6, decimalsB: 8, tickSpacing: 10,
};
const MULT1 = {
  symbolA: "TSLA", symbolB: "TSLAx",
  multiplierA: 1, multiplierB: 1,
  onChainPriceBPerA: 1.0001,
  decimalsA: 6, decimalsB: 8, tickSpacing: 10,
};
const TTWO = {
  symbolA: "TTWO", symbolB: "TTWOx",
  multiplierA: 1, multiplierB: 1.03, // fair ≈ 0.9709; a near-1 on-chain price is >2% away
  onChainPriceBPerA: 0.999,
  decimalsA: 6, decimalsB: 8, tickSpacing: 10,
};

function tickOf(price: number, decimalsA: number, decimalsB: number) {
  return Math.round(exactTickFromUiPrice(price, decimalsA, decimalsB));
}

describe("openRangeCenterPrice", () => {
  it("NVDAx: centers on fair (multA/multB), not 1 and not the on-chain price", () => {
    const center = openRangeCenterPrice(NVDA);
    const fair = fairPriceFor({ ...NVDA, price: NVDA.onChainPriceBPerA })!;
    expect(fair).not.toBeNull();
    expect(center).toBe(fair.fair);
    expect(center).toBeCloseTo(1 / 1.001701196801074, 12);
    expect(center).not.toBe(1);
    expect(center).not.toBe(NVDA.onChainPriceBPerA);
  });

  it("SPYx: centers on fair, not 1 and not the on-chain price", () => {
    const center = openRangeCenterPrice(SPY);
    expect(center).toBeCloseTo(1 / 1.007474126658766, 12);
    expect(center).not.toBe(1);
    expect(center).not.toBe(SPY.onChainPriceBPerA);
  });

  it("SNDK both sides 8: fair is 1, so the center matches 1:1 centering", () => {
    const center = openRangeCenterPrice(SNDK);
    expect(center).toBe(1);
    expect(fairPriceFor({ ...SNDK, price: SNDK.onChainPriceBPerA })?.fair).toBe(1);
  });

  it("null case (TTWOx-like, >2% from fair): falls back to the on-chain price", () => {
    expect(fairPriceFor({ ...TTWO, price: TTWO.onChainPriceBPerA })).toBeNull();
    expect(openRangeCenterPrice(TTWO)).toBe(TTWO.onChainPriceBPerA);
  });

  it("multiplier-1 pool near 1: fair is 1, same center as 1:1", () => {
    const center = openRangeCenterPrice(MULT1);
    expect(center).toBe(1);
    expect(fairPriceFor({ ...MULT1, price: MULT1.onChainPriceBPerA })?.fair).toBe(1);
  });

  it("missing multipliers: falls back to the on-chain price", () => {
    expect(openRangeCenterPrice({ onChainPriceBPerA: 0.995 })).toBe(0.995);
  });
});

describe("default standard range before/after fair centering", () => {
  it("keeps width and recenters NVDAx, SPYx, SNDK, and a multiplier-1 pool", () => {
    const cases = [
      { name: "NVDAx", pool: NVDA },
      { name: "SPYx", pool: SPY },
      { name: "SNDK", pool: SNDK },
      { name: "multiplier-1", pool: MULT1 },
    ] as const;
    for (const { name, pool } of cases) {
      const tickCurrent = tickOf(pool.onChainPriceBPerA, pool.decimalsA, pool.decimalsB);
      const currentPrice = uiPriceBPerAFromTick(tickCurrent, pool.decimalsA, pool.decimalsB);
      const before = standardRange({
        currentPrice, tickCurrent, decimalsA: pool.decimalsA, decimalsB: pool.decimalsB,
        tickSpacing: pool.tickSpacing, centerOnParity: true, // historical default: center on 1
      });
      const centerPrice = openRangeCenterPrice({ ...pool, onChainPriceBPerA: currentPrice });
      const after = standardRange({
        currentPrice, tickCurrent, decimalsA: pool.decimalsA, decimalsB: pool.decimalsB,
        tickSpacing: pool.tickSpacing, centerPrice,
      });
      expect(after.tickUpper - after.tickLower, name).toBe(before.tickUpper - before.tickLower);
      if (name === "SNDK" || name === "multiplier-1") {
        expect(after.tickLower, name).toBe(before.tickLower);
        expect(after.tickUpper, name).toBe(before.tickUpper);
      } else {
        expect([after.tickLower, after.tickUpper], name).not.toEqual([before.tickLower, before.tickUpper]);
      }
    }
  });

  it("TTWOx-like null case matches centering on the on-chain price, not on 1", () => {
    const tickCurrent = tickOf(TTWO.onChainPriceBPerA, TTWO.decimalsA, TTWO.decimalsB);
    const currentPrice = uiPriceBPerAFromTick(tickCurrent, TTWO.decimalsA, TTWO.decimalsB);
    const parity = standardRange({
      currentPrice, tickCurrent, decimalsA: TTWO.decimalsA, decimalsB: TTWO.decimalsB,
      tickSpacing: TTWO.tickSpacing, centerOnParity: true,
    });
    const centerPrice = openRangeCenterPrice({ ...TTWO, onChainPriceBPerA: currentPrice });
    expect(centerPrice).toBe(currentPrice);
    const after = standardRange({
      currentPrice, tickCurrent, decimalsA: TTWO.decimalsA, decimalsB: TTWO.decimalsB,
      tickSpacing: TTWO.tickSpacing, centerPrice,
    });
    const onChainCenter = standardRange({
      currentPrice, tickCurrent, decimalsA: TTWO.decimalsA, decimalsB: TTWO.decimalsB,
      tickSpacing: TTWO.tickSpacing, centerPrice: currentPrice,
    });
    expect(after.tickLower).toBe(onChainCenter.tickLower);
    expect(after.tickUpper).toBe(onChainCenter.tickUpper);
    expect(after.tickLower).not.toBe(parity.tickLower);
  });
});


const PRESET_IDS = ["micro", "tight", "standard", "wide"] as const;

function resolvePreset(preset: (typeof PRESET_IDS)[number], input: {
  currentPrice: number;
  tickCurrent: number;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
  centerPrice?: number;
  centerOnParity?: boolean;
}) {
  const sqrtPriceX64 = TickUtil.getSqrtPriceAtTick(input.tickCurrent).toString();
  return resolveOpenRange({
    range: {
      preset,
      centerOnParity: input.centerOnParity ?? true,
      ...(input.centerPrice !== undefined ? { centerPrice: input.centerPrice } : {}),
    },
    currentPrice: input.currentPrice,
    tickCurrent: input.tickCurrent,
    sqrtPriceX64,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
    tickSpacing: input.tickSpacing,
  });
}

describe("fair-center then current-price fallback", () => {
  it("unitCenterWithCurrentFallback keeps the fair center when current is inside the inclusive band, otherwise recenters", () => {
    expect(unitBand(45980, 10)).toEqual({ lower: 45975, upper: 45984 });
    expect(unitCenterWithCurrentFallback(45980, 45980, 10)).toBe(45980);
    expect(unitCenterWithCurrentFallback(45980, 45984, 10)).toBe(45980);
    expect(unitCenterWithCurrentFallback(45980, 45992, 10)).toBe(45992);
  });

  it("covers every preset for NVDAx, SPYx (including the Tight counterexample), SNDK, and multiplier-1", () => {
    const spyxTight = {
      name: "SPYx",
      fairUnit: 45980,
      tickCurrent: 45992,
      decimalsA: 6,
      decimalsB: 8,
      tickSpacing: 10,
    };
    const cases = [
      spyxTight,
      { name: "NVDAx", fairUnit: 46037, tickCurrent: 46041, decimalsA: 6, decimalsB: 8, tickSpacing: 1 },
      { name: "SNDK", fairUnit: 0, tickCurrent: 2, decimalsA: 6, decimalsB: 8, tickSpacing: 10 },
      { name: "multiplier-1", fairUnit: 0, tickCurrent: 1, decimalsA: 6, decimalsB: 8, tickSpacing: 10 },
    ] as const;

    for (const pool of cases) {
      const currentPrice = uiPriceBPerAFromTick(pool.tickCurrent, pool.decimalsA, pool.decimalsB);
      const fairPrice = uiPriceBPerAFromTick(pool.fairUnit, pool.decimalsA, pool.decimalsB);
      for (const preset of PRESET_IDS) {
        const label = `${pool.name} ${preset}`;
        const after = resolvePreset(preset, {
          currentPrice,
          tickCurrent: pool.tickCurrent,
          decimalsA: pool.decimalsA,
          decimalsB: pool.decimalsB,
          tickSpacing: pool.tickSpacing,
          centerPrice: fairPrice,
        });
        expect(tickRangeContainsCurrent(after.tickLower, after.tickUpper, pool.tickCurrent), label).toBe(true);

        const units = (after.tickUpper - after.tickLower) / pool.tickSpacing;
        const used = unitCenterWithCurrentFallback(pool.fairUnit, pool.tickCurrent, units);
        if (pool.name === "SPYx" && preset === "tight") {
          expect(used, label).toBe(pool.tickCurrent);
          const currentCentered = resolvePreset(preset, {
            currentPrice,
            tickCurrent: pool.tickCurrent,
            decimalsA: pool.decimalsA,
            decimalsB: pool.decimalsB,
            tickSpacing: pool.tickSpacing,
            centerOnParity: false,
          });
          expect(after.tickLower, label).toBe(currentCentered.tickLower);
          expect(after.tickUpper, label).toBe(currentCentered.tickUpper);
        } else {
          // Wider presets (and NVDAx Tight, whose 4-unit gap still fits) stay on the fair center.
          const fairBand = unitBand(pool.fairUnit, units);
          const currentInsideFair = pool.tickCurrent >= fairBand.lower && pool.tickCurrent <= fairBand.upper;
          if (currentInsideFair) expect(used, label).toBe(pool.fairUnit);
        }
      }
    }
  });

  it("SPYx Tight counterexample: fair 45980, current 45992 is outside the fair Tight band", () => {
    const currentPrice = uiPriceBPerAFromTick(45992, 6, 8);
    const fairPrice = uiPriceBPerAFromTick(45980, 6, 8);
    const tight = resolvePreset("tight", {
      currentPrice, tickCurrent: 45992, decimalsA: 6, decimalsB: 8, tickSpacing: 10, centerPrice: fairPrice,
    });
    const standard = resolvePreset("standard", {
      currentPrice, tickCurrent: 45992, decimalsA: 6, decimalsB: 8, tickSpacing: 10, centerPrice: fairPrice,
    });
    const currentCenteredTight = resolvePreset("tight", {
      currentPrice, tickCurrent: 45992, decimalsA: 6, decimalsB: 8, tickSpacing: 10, centerOnParity: false,
    });
    expect(tickRangeContainsCurrent(tight.tickLower, tight.tickUpper, 45992)).toBe(true);
    expect(tight.tickLower).toBe(currentCenteredTight.tickLower);
    expect(tight.tickUpper).toBe(currentCenteredTight.tickUpper);
    expect(tickRangeContainsCurrent(standard.tickLower, standard.tickUpper, 45992)).toBe(true);
    // Standard is wide enough to keep the fair center.
    const fairCenteredStandard = resolvePreset("standard", {
      currentPrice, tickCurrent: 45980, decimalsA: 6, decimalsB: 8, tickSpacing: 10, centerPrice: fairPrice,
    });
    expect(standard.tickLower).toBe(fairCenteredStandard.tickLower);
    expect(standard.tickUpper).toBe(fairCenteredStandard.tickUpper);
    expect(OPEN_RANGE_PRESETS.map((p) => p.id)).toEqual(["tight", "standard", "wide"]);
  });
});
