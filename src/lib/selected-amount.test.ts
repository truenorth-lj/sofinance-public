import { describe, expect, it } from "vitest";
import { parseTokenAmount } from "./amount";
import { allocateSpend } from "./quote-math";

describe("selected asset amounts", () => {
  it("parses token precision without converting through a JS number", () => {
    expect(parseTokenAmount("1.23456789", 8)).toBe(123_456_789n);
    expect(parseTokenAmount("0.000000001", 9)).toBe(1n);
    expect(parseTokenAmount("15", 0)).toBe(15n);
    expect(() => parseTokenAmount("0.0000000001", 9)).toThrow();
    expect(() => parseTokenAmount("18446744073709551616", 0)).toThrow();
  });

  it("allows a pool asset split below the former one USDC minimum", () => {
    expect(allocateSpend(100n, 1n, 1n, { spend: 1n, out: 1n }, { spend: 1n, out: 1n }, 1n)).toBe(50n);
  });
});
