import { describe, expect, it } from "vitest";
import { rawAmountUsdLabel, typedAmountUsdLabel } from "./token-usd";

describe("display USD for one token amount", () => {
  it("values a raw balance as raw / 10^decimals × USD per raw unit (multiplier already in the price)", () => {
    // 1.5 tokens of a ×2 scaled stock whose share trades at $100: $200 per raw unit → $300.
    expect(rawAmountUsdLabel("1500000", 6, 200)).toBe("≈ $300.00");
    expect(rawAmountUsdLabel("1", 6, 1)).toBe("< $0.01");
  });
  it("values a typed amount in the same raw / 10^decimals units", () => {
    expect(typedAmountUsdLabel("1.5", 200)).toBe("≈ $300.00");
  });
  it("shows nothing when the price is unknown or the amount is not usable", () => {
    expect(rawAmountUsdLabel("1500000", 6, null)).toBeNull();
    expect(rawAmountUsdLabel("1500000", 6, undefined)).toBeNull();
    expect(rawAmountUsdLabel("1500000", 6, Number.NaN)).toBeNull();
    expect(rawAmountUsdLabel("1500000", 6, -1)).toBeNull();
    expect(rawAmountUsdLabel("not-a-number", 6, 1)).toBeNull();
    expect(typedAmountUsdLabel("", 1)).toBeNull();
    expect(typedAmountUsdLabel("0", 1)).toBeNull();
    expect(typedAmountUsdLabel("abc", 1)).toBeNull();
    expect(typedAmountUsdLabel("1", null)).toBeNull();
  });
});
