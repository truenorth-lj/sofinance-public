import { describe, expect, it } from "vitest";
import { poolFeeTierLabel, poolPairLabel, poolPairLabelFromSymbols } from "./pool-names";

describe("poolPairLabel", () => {
  it("re-joins the canonical App pairLabel with the given separator", () => {
    expect(poolPairLabel({ pairLabel: "TSLAx/TSLA" })).toBe("TSLAx/TSLA");
    expect(poolPairLabel({ pairLabel: "TSLAx/TSLA" }, " / ")).toBe("TSLAx / TSLA");
    expect(poolPairLabel({ pairLabel: "TSLA / TSLAx" }, " / ")).toBe("TSLA / TSLAx");
    expect(poolPairLabel({ pairLabel: "SPCX/SPCXon" }, " / ")).toBe("SPCX / SPCXon");
  });

  it("uses pairLabel order, not symbol mint order", () => {
    expect(poolPairLabel({ pairLabel: "TSLAx/TSLA" }, " / ")).toBe("TSLAx / TSLA");
    expect(poolPairLabel({ pairLabel: "AAPLx/AAPL" }, " / ")).toBe("AAPLx / AAPL");
  });
});

describe("poolPairLabelFromSymbols", () => {
  it("puts the wrapped symbol first for FOOx/FOO pairs, even when the plain token is listed first", () => {
    expect(poolPairLabelFromSymbols("TSLAx", "TSLA")).toBe("TSLAx/TSLA");
    expect(poolPairLabelFromSymbols("TSLA", "TSLAx", " / ")).toBe("TSLAx / TSLA");
    expect(poolPairLabelFromSymbols("SPCX", "SPCXx", " / ")).toBe("SPCXx / SPCX");
  });

  it("keeps Robinhood-first order for ondo-style symbols that are not a wrap pair", () => {
    expect(poolPairLabelFromSymbols("SPCX", "SPCXon", " / ")).toBe("SPCX / SPCXon");
    expect(poolPairLabelFromSymbols("TSLA", "TSLAon")).toBe("TSLA/TSLAon");
  });
});

describe("poolFeeTierLabel", () => {
  it("writes the fee in bps, like the App cards", () => {
    expect(poolFeeTierLabel(1)).toBe("1 bps");
    expect(poolFeeTierLabel(5)).toBe("5 bps");
    expect(poolFeeTierLabel(10)).toBe("10 bps");
    expect(poolFeeTierLabel(25)).toBe("25 bps");
  });

  it("returns null when the fee is missing", () => {
    expect(poolFeeTierLabel(null)).toBeNull();
    expect(poolFeeTierLabel(undefined)).toBeNull();
    expect(poolFeeTierLabel(Number.NaN)).toBeNull();
    expect(poolFeeTierLabel(-1)).toBeNull();
  });
});
