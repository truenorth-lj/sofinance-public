import { describe, expect, it } from "vitest";
import { parseDays, parseUsdc } from "./lp-intent";

describe("plan input parsing", () => {
  it("accepts grouped decimals and rejects junk, zero and oversize values", () => {
    expect(parseUsdc("1,000.50")).toBe("1000.5");
    expect(parseUsdc("0")).toBeNull();
    expect(parseUsdc("-5")).toBeNull();
    expect(parseUsdc("1e3")).toBeNull();
    expect(parseUsdc("1.1234567")).toBeNull();
    expect(parseUsdc("10000001")).toBeNull();
    expect(parseUsdc("200", "100")).toBeNull();
  });

  it("keeps the horizon within 1–365 whole days", () => {
    expect(parseDays("30")).toBe(30);
    expect(parseDays("0")).toBeNull();
    expect(parseDays("366")).toBeNull();
    expect(parseDays("7.5")).toBeNull();
  });
});
