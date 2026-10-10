import { describe, expect, it } from "vitest";
import {
  describeResaleFloorFailure,
  parseTokenAmount,
  simulatedInputSpendMatches,
  suggestedResaleFloorBps,
} from "./amount";
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

describe("simulatedInputSpendMatches", () => {
  it("accepts the live 0.1% USDC underspend and rejects overspend", () => {
    expect(simulatedInputSpendMatches(2_199_933n, 2_200_000n)).toBe(true);
    expect(simulatedInputSpendMatches(2_200_000n, 2_200_000n)).toBe(true);
    expect(simulatedInputSpendMatches(2_197_000n, 2_200_000n)).toBe(false);
    expect(simulatedInputSpendMatches(2_200_001n, 2_200_000n)).toBe(false);
    expect(simulatedInputSpendMatches(0n, 2_200_000n)).toBe(false);
  });
});

describe("describeResaleFloorFailure", () => {
  it("suggests a passing floor and a max amount", () => {
    const advice = describeResaleFloorFailure(1_000_000n, 980_000n, 9_900);
    expect(advice.achievedResaleBps).toBe(9_800);
    expect(advice.suggestedResaleFloorBps).toBe(9_800);
    expect(Number(advice.maxAmountForFloor)).toBeLessThan(1_000_000);
    expect(advice.warning).toMatch(/9800/);
    expect(suggestedResaleFloorBps(1_000_000n, 980_000n)).toBe(9_800);
  });
});
