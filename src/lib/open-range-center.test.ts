import { describe, expect, it } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { resolveOpenRange } from "@sofinance/engine/open-range";
import { uiPriceBPerAFromTick } from "@sofinance/engine/position-performance-math";
import { exactTickFromUiPrice } from "@sofinance/engine/range-apr/tick-math";
import { openRangeCenterPrice } from "./open-range-center";
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
