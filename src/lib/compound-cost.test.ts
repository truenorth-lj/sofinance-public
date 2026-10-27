import { describe, expect, it } from "vitest";
import { formatUsdcValue } from "./compound-cost";

describe("compound value formatting", () => {
  it("keeps small harvest values and zero distinguishable", () => {
    expect(formatUsdcValue(0.000687)).toBe("0.000687 USDC");
    expect(formatUsdcValue(0)).toBe("0 USDC");
    expect(formatUsdcValue(null)).toBe("USDC estimate unavailable");
  });
});
