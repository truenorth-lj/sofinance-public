import { describe, expect, it } from "vitest";
import { formatHoldingTime, returnUnavailableReason } from "./position-performance-display";

describe("performance display", () => {
  it("uses hours below 24 hours and days at and above 24 hours", () => {
    expect(formatHoldingTime(0.5)).toEqual({ label: "Holding hours", value: "12.00 hr" });
    expect(formatHoldingTime(23 / 24)).toEqual({ label: "Holding hours", value: "23.00 hr" });
    expect(formatHoldingTime(1)).toEqual({ label: "Holding days", value: "1.00 days" });
    expect(formatHoldingTime(1.5)).toEqual({ label: "Holding days", value: "1.50 days" });
    expect(formatHoldingTime(null).value).toBe("—");
    expect(formatHoldingTime(NaN).value).toBe("—");
    expect(formatHoldingTime(0).value).toBe("—");
  });

  it("distinguishes missing deposit history, holding time and USD prices", () => {
    const input = { deposited: 0, holdingDays: null, needsHoldingTime: true, missingUsdPrice: false, truncated: false };
    expect(returnUnavailableReason(input)).toContain("No positive deposit amount");
    expect(returnUnavailableReason({ ...input, truncated: true })).toContain("Earlier transactions");
    expect(returnUnavailableReason({ ...input, deposited: 100 })).toContain("positive holding time");
    expect(returnUnavailableReason({ ...input, missingUsdPrice: true })).toContain("USD prices");
    expect(returnUnavailableReason({ ...input, deposited: 100, needsHoldingTime: false })).not.toContain("holding time");
  });
});
