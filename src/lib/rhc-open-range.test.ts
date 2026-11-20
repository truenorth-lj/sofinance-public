import { describe, expect, it } from "vitest";
import { rhcDefaultOpenTicks, rhcRangeSide } from "./rhc-open-range";

const halfWidth = 10;

function pool(tick: number, over: { symbol0?: string; symbol1?: string; multiplier0?: number; multiplier1?: number } = {}) {
  return {
    tick,
    token0: { symbol: over.symbol0 ?? "NVDA", decimals: 18 },
    token1: { symbol: over.symbol1 ?? "NVDAon", decimals: 18 },
    ...(over.multiplier0 !== undefined ? { multiplier0: over.multiplier0 } : {}),
    ...(over.multiplier1 !== undefined ? { multiplier1: over.multiplier1 } : {}),
  };
}

describe("rhcDefaultOpenTicks", () => {
  it("always centers on the current on-chain tick, ignoring any uiMultiplier", () => {
    const nvda = rhcDefaultOpenTicks(pool(-12, { multiplier0: 1.0007751591646306, multiplier1: 1 }), halfWidth)!;
    expect(nvda).toEqual({ center: -12, tickLower: -22, tickUpper: -2 });
    expect(rhcRangeSide(-12, nvda.tickLower, nvda.tickUpper)).toBe("inside");

    const spy = rhcDefaultOpenTicks(pool(-80, { symbol0: "SPY", symbol1: "SPYon", multiplier0: 1.001717991187472, multiplier1: 1 }), halfWidth)!;
    expect(spy).toEqual({ center: -80, tickLower: -90, tickUpper: -70 });
    expect(rhcRangeSide(-80, spy.tickLower, spy.tickUpper)).toBe("inside");

    const spcx = rhcDefaultOpenTicks(pool(-1, { symbol0: "SPCX", symbol1: "SPCXon", multiplier0: 1, multiplier1: 1 }), halfWidth)!;
    expect(spcx).toEqual({ center: -1, tickLower: -11, tickUpper: 9 });
    expect(rhcRangeSide(-1, spcx.tickLower, spcx.tickUpper)).toBe("inside");
  });

  it("returns null when the on-chain tick is missing", () => {
    expect(rhcDefaultOpenTicks({ tick: null, token0: { symbol: "NVDA", decimals: 18 }, token1: { symbol: "NVDAon", decimals: 18 } }, halfWidth)).toBeNull();
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
