import { describe, expect, it } from "vitest";
import { exactAprTitle, formatAprPct } from "./format-apr";

describe("formatAprPct", () => {
  it("shows missing data as — (never 0.00%)", () => {
    for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY]) expect(formatAprPct(value)).toBe("—");
  });
  it("shows a tiny real APR as <0.01% instead of rounding it to 0.00%", () => {
    expect(formatAprPct(0.0005575645952321763)).toBe("<0.01%");
    expect(formatAprPct(0.0049)).toBe("<0.01%");
    expect(exactAprTitle(0.0005575645952321763)).toBe("≈0.00056%");
  });
  it("keeps two decimals otherwise", () => {
    expect(formatAprPct(0.005)).toBe("0.01%");
    expect(formatAprPct(7.5)).toBe("7.50%");
    expect(formatAprPct(0)).toBe("0.00%");
    expect(exactAprTitle(7.5)).toBeUndefined();
  });
});
