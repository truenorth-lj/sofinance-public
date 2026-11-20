import { describe, expect, it } from "vitest";
import { exactTickFromUiPrice, uiPriceFromTick } from "@sofinance/engine/range-apr/tick-math";
import { rhcDefaultOpenTicks, rhcRangeSide } from "./rhc-open-range";
import { openRangeCenterPrice } from "./open-range-center";

/** First RHC range preset is ±10 ticks. */
const halfWidth = 10;

/** Live Robinhood `uiMultiplier()` (1e18-scaled) as of the on-chain check for this PR. */
const NVDA_UI = 1.000775159164630595;
const SPY_UI = 1.001717991187472003;

function pool(over: Partial<{ tick: number; multiplier0: number; multiplier1: number; symbol0: string; symbol1: string }>) {
  return {
    tick: over.tick ?? 0,
    token0: { symbol: over.symbol0 ?? "NVDA", decimals: 18 },
    token1: { symbol: over.symbol1 ?? "NVDAon", decimals: 18 },
    ...(over.multiplier0 !== undefined ? { multiplier0: over.multiplier0 } : {}),
    ...(over.multiplier1 !== undefined ? { multiplier1: over.multiplier1 } : {}),
  };
}

describe("rhcDefaultOpenTicks", () => {
  it("NVDA/NVDAon: fair-center ticks differ from 1:1 and follow openRangeCenterPrice", () => {
    const current = pool({ tick: -1, multiplier0: NVDA_UI, multiplier1: 1 });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    const fair = openRangeCenterPrice({
      multiplierA: NVDA_UI, multiplierB: 1,
      onChainPriceBPerA: uiPriceFromTick(-1, 18, 18),
    });
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(fair, 18, 18)));
    expect(after.center).not.toBe(Math.round(exactTickFromUiPrice(1, 18, 18)));
    expect(after.tickUpper - after.tickLower).toBe(2 * halfWidth);
  });

  it("SPY/SPYon: fair-center is not the 1:1 tick", () => {
    const current = pool({ tick: -1, multiplier0: SPY_UI, multiplier1: 1, symbol0: "SPY", symbol1: "SPYon" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).not.toBe(Math.round(exactTickFromUiPrice(1, 18, 18)));
  });

  it("SPCX both sides 1: fair is 1, so ticks match the previous 1:1 center", () => {
    const current = pool({ tick: 40, multiplier0: 1, multiplier1: 1, symbol0: "SPCX", symbol1: "SPCXon" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(1, 18, 18)));
  });

  it("null case (>2% from fair): falls back to the on-chain tick, not 1:1", () => {
    const current = pool({ tick: 25, multiplier0: 1, multiplier1: 1.03, symbol0: "TTWO", symbol1: "TTWOon" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    const market = rhcDefaultOpenTicks(current, halfWidth, false)!;
    expect(after.center).toBe(market.center);
    expect(after.center).toBe(25);
    expect(after.center).not.toBe(Math.round(exactTickFromUiPrice(1, 18, 18)));
  });

  it("multiplier-1 near current tick 5: same ticks as 1:1 centering", () => {
    const current = pool({ tick: 5, multiplier0: 1, multiplier1: 1, symbol0: "TSLA", symbol1: "TSLAon" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(1, 18, 18)));
  });
});

describe("rhcRangeSide", () => {
  it("uses the same in-range / out-of-range sides as Raydium (exclusive upper bound)", () => {
    expect(rhcRangeSide(0, -10, 10)).toBe("inside");
    expect(rhcRangeSide(-10, -10, 10)).toBe("inside");
    expect(rhcRangeSide(10, -10, 10)).toBe("above");
    expect(rhcRangeSide(-11, -10, 10)).toBe("below");
  });
});
