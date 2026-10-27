import { describe, expect, it } from "vitest";
import { acceptableReportedPriceImpact } from "./quote-guards";

describe("Jupiter price-impact estimate", () => {
  it("accepts a finite value at the configured cap", () => {
    expect(acceptableReportedPriceImpact("0.05", 500)).toBe(true);
    expect(acceptableReportedPriceImpact(undefined, 500)).toBe(true);
  });

  it("rejects values that could bypass the cap through NaN or coercion", () => {
    for (const value of ["0.05001", "NaN", "oops", "Infinity", "-0.01", null, {}]) {
      expect(acceptableReportedPriceImpact(value, 500)).toBe(false);
    }
  });
});
