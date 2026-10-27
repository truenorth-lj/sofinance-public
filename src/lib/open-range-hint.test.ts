import { describe, expect, it } from "vitest";
import {
  SMALL_AMOUNT_NARROW_RANGE_HINT, SMALL_OPEN_AMOUNT_USDC, smallAmountNarrowRangeHint,
} from "./open-range-hint";

describe("smallAmountNarrowRangeHint", () => {
  it("suggests a wider range for a few USDC on Micro, Tight, or Best-resolved narrow presets", () => {
    expect(SMALL_OPEN_AMOUNT_USDC).toBe(10);
    expect(smallAmountNarrowRangeHint(5, "micro")).toBe(SMALL_AMOUNT_NARROW_RANGE_HINT);
    expect(smallAmountNarrowRangeHint(5, "tight")).toBe(SMALL_AMOUNT_NARROW_RANGE_HINT);
    expect(smallAmountNarrowRangeHint(10, "tight")).toBe(SMALL_AMOUNT_NARROW_RANGE_HINT);
  });

  it("stays quiet for larger amounts or wider ranges", () => {
    expect(smallAmountNarrowRangeHint(11, "tight")).toBeNull();
    expect(smallAmountNarrowRangeHint(5, "standard")).toBeNull();
    expect(smallAmountNarrowRangeHint(5, "wide")).toBeNull();
    expect(smallAmountNarrowRangeHint(null, "micro")).toBeNull();
    expect(smallAmountNarrowRangeHint(0, "micro")).toBeNull();
  });
});
