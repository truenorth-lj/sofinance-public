import { describe, expect, it, vi } from "vitest";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS, CLEANUP_PRIORITY_MAX_LAMPORTS, CLEANUP_UNITS_MAX, CLEANUP_UNITS_MIN, cleanupBudgetInstructions,
  cleanupComputeUnitLimit, cleanupComputeUnitPrice, recentPrioritizationSamples } from "./cleanup-priority-fee";

describe("cleanupComputeUnitLimit", () => {
  it("adds headroom to the measured units and clamps", () => {
    expect(cleanupComputeUnitLimit(100_000, 4)).toBe(130_000);
    expect(cleanupComputeUnitLimit(10, 1)).toBe(CLEANUP_UNITS_MIN);
    expect(cleanupComputeUnitLimit(5_000_000, 1)).toBe(CLEANUP_UNITS_MAX);
  });
  it("uses a per-account allowance when nothing was measured", () => {
    for (const bad of [undefined, 0, Number.NaN]) expect(cleanupComputeUnitLimit(bad, 4)).toBe(50_000 + 4 * 60_000);
    expect(cleanupComputeUnitLimit(undefined, 64)).toBe(CLEANUP_UNITS_MAX);
  });
});
describe("cleanupComputeUnitPrice", () => {
  it("is never below the floor, even on an idle network", () => {
    expect(cleanupComputeUnitPrice([], 100_000)).toBe(CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS);
    expect(cleanupComputeUnitPrice([0, 0, 0], 100_000)).toBe(CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS);
  });
  it("tracks the 75th percentile of recent fees", () => {
    const samples = Array.from({ length: 100 }, (_, index) => (index + 1) * 1_000);
    expect(cleanupComputeUnitPrice(samples, 100_000)).toBe(76_000);
  });
  it("never lets the whole priority fee pass the ceiling", () => {
    for (const units of [10_000, 130_000, 1_400_000]) {
      const price = cleanupComputeUnitPrice([1e12], units);
      expect(Math.ceil(units * price / 1_000_000)).toBeLessThanOrEqual(CLEANUP_PRIORITY_MAX_LAMPORTS);
    }
  });
});
describe("recentPrioritizationSamples", () => {
  it("returns the per-slot fees, and nothing when the RPC method is missing or fails", async () => {
    expect(await recentPrioritizationSamples({ getRecentPrioritizationFees: vi.fn(async () => [{ slot: 1, prioritizationFee: 7 }, { slot: 2, prioritizationFee: 9 }]) })).toEqual([7, 9]);
    expect(await recentPrioritizationSamples({ getRecentPrioritizationFees: vi.fn(async () => { throw new Error("429"); }) })).toEqual([]);
    expect(await recentPrioritizationSamples({} as never)).toEqual([]);
  });
});
describe("cleanupBudgetInstructions", () => {
  it("is the limit then the price, as ComputeBudget instructions", () => {
    const [limit, price] = cleanupBudgetInstructions({ units: 130_000, microLamports: 5_000 });
    expect(limit!.programId.equals(ComputeBudgetProgram.programId) && limit!.data[0]).toBe(2);
    expect(price!.data[0]).toBe(3);
  });
});
