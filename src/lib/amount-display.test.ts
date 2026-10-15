import { describe, expect, it } from "vitest";
import { formatAmount, formatAmountDisplay } from "@sofinance/engine/amount";

describe("formatAmountDisplay", () => {
  it("matches formatAmount for ordinary amounts, with no exponent notation at the edges", () => {
    for (const [raw, decimals] of [["1234567800", 8], ["50000000", 8], ["1500000", 6], ["123456789012345678", 9],
      ["18446744073709551615", 9], ["9007199254740993", 9], ["0", 9], ["99999999500000000", 9]] as const) {
      expect(formatAmountDisplay(raw, decimals)).toBe(formatAmount(raw, decimals));
    }
    expect(formatAmountDisplay("123456789012345678", 9)).toBe("123456789.012345");
    expect(formatAmountDisplay("9007199254740993", 9)).toBe("9007199.25474");
  });
  it("keeps non-zero dust visible instead of printing 0", () => {
    expect(formatAmountDisplay("1", 9)).toBe("<0.000001");
    expect(formatAmountDisplay("999", 9)).toBe("<0.000001");
    expect(formatAmountDisplay("1", 6)).toBe("0.000001");
    expect(formatAmountDisplay("0", 9)).toBe("0");
  });
  it("shows a dash for missing or non-integer input instead of throwing or printing NaN", () => {
    for (const bad of [null, undefined, "", "abc", "1.5", "NaN"]) expect(formatAmountDisplay(bad, 6)).toBe("—");
  });
});
