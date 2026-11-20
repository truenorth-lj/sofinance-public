import { describe, expect, it } from "vitest";
import { exactTickFromUiPrice, uiPriceFromTick } from "@sofinance/engine/range-apr/tick-math";
import { rhcDefaultOpenTicks, rhcRangeSide } from "./rhc-open-range";
import { openRangeCenterPrice } from "./open-range-center";

const halfWidth = 30;

function pool(over: Partial<{ tick: number; multiplier0: number; multiplier1: number; symbol0: string; symbol1: string }>) {
  return {
    tick: over.tick ?? 0,
    token0: { symbol: over.symbol0 ?? "NVDA", decimals: 6 },
    token1: { symbol: over.symbol1 ?? "NVDAx", decimals: 6 },
    ...(over.multiplier0 !== undefined ? { multiplier0: over.multiplier0 } : {}),
    ...(over.multiplier1 !== undefined ? { multiplier1: over.multiplier1 } : {}),
  };
}

describe("rhcDefaultOpenTicks", () => {
  it("NVDAx: fair-center ticks differ from 1:1 and follow fairPriceFor", () => {
    const current = pool({ tick: 20, multiplier0: 1, multiplier1: 1.001701196801074 });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    const legacy = {
      center: Math.round(exactTickFromUiPrice(1, 6, 6)),
    };
    const fair = openRangeCenterPrice({
      symbolA: "NVDA", symbolB: "NVDAx", multiplierA: 1, multiplierB: 1.001701196801074,
      onChainPriceBPerA: uiPriceFromTick(20, 6, 6),
    });
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(fair, 6, 6)));
    expect(after.center).not.toBe(legacy.center);
    expect(after.tickUpper - after.tickLower).toBe(2 * halfWidth);
  });

  it("SPYx: fair-center is not the 1:1 tick", () => {
    const current = pool({ tick: 15, multiplier0: 1, multiplier1: 1.007474126658766, symbol0: "SPY", symbol1: "SPYx" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).not.toBe(Math.round(exactTickFromUiPrice(1, 6, 6)));
  });

  it("SNDK both sides 8: fair is 1, so ticks match the previous 1:1 center", () => {
    const current = pool({ tick: 40, multiplier0: 8, multiplier1: 8, symbol0: "SNDK", symbol1: "SNDKx" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(1, 6, 6)));
  });

  it("null case (TTWOx-like): falls back to the on-chain tick, not 1:1", () => {
    const current = pool({ tick: 25, multiplier0: 1, multiplier1: 1.03, symbol0: "TTWO", symbol1: "TTWOx" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    const market = rhcDefaultOpenTicks(current, halfWidth, false)!;
    expect(after.center).toBe(market.center);
    expect(after.center).toBe(25);
    expect(after.center).not.toBe(Math.round(exactTickFromUiPrice(1, 6, 6)));
  });

  it("multiplier-1 near 1: same ticks as 1:1 centering", () => {
    const current = pool({ tick: 5, multiplier0: 1, multiplier1: 1, symbol0: "TSLA", symbol1: "TSLAx" });
    const after = rhcDefaultOpenTicks(current, halfWidth, true)!;
    expect(after.center).toBe(Math.round(exactTickFromUiPrice(1, 6, 6)));
  });
});

describe("rhcRangeSide", () => {
  it("uses the same in-range / out-of-range sides as Raydium (exclusive upper bound)", () => {
    expect(rhcRangeSide(0, -30, 30)).toBe("inside");
    expect(rhcRangeSide(-30, -30, 30)).toBe("inside");
    expect(rhcRangeSide(30, -30, 30)).toBe("above");
    expect(rhcRangeSide(-31, -30, 30)).toBe("below");
  });
});
