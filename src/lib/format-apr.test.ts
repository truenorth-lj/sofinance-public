import { describe, expect, it } from "vitest";
import { formatAprPct } from "./format-apr";

describe("formatAprPct", () => {
  it("shows — for missing data, never 0%", () => {
    expect(formatAprPct(null)).toBe("—");
    expect(formatAprPct(undefined)).toBe("—");
    expect(formatAprPct(Number.NaN)).toBe("—");
    expect(formatAprPct(Number.POSITIVE_INFINITY)).toBe("—");
  });
  it("shows <0.01% for tiny positive values (the RHC 24h case: 0.000558%)", () => {
    expect(formatAprPct(0.000558)).toBe("<0.01%");
    expect(formatAprPct(0.0099)).toBe("<0.01%");
  });
  it("uses two decimals otherwise", () => {
    expect(formatAprPct(0.01)).toBe("0.01%");
    expect(formatAprPct(7.5)).toBe("7.50%");
    expect(formatAprPct(0)).toBe("0.00%");
  });
});
