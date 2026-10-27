import { describe, expect, it, vi } from "vitest";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import {
  ALLOCATE_MAX_ROUNDS, MATERIAL_LEFTOVER_PCT, OPEN_POSITION_ALLOCATE_MODE,
  adjustedPoolPriceSpendA, allocateOpenPosition, extraUnpairedPct, leftoverIsMateriallyWorse,
  parseOpenAllocateMode, poolPriceSpendA, type OpenAllocatePool, type OpenAllocateQuoteFn,
} from "./open-allocate";

function pool(overrides: Partial<OpenAllocatePool> = {}): OpenAllocatePool {
  const tickLower = -30;
  const tickUpper = 30;
  return {
    mintA: "A", mintB: "B",
    sqrtPriceX64: TickUtil.getSqrtPriceAtTick(0).toString(),
    tickCurrent: 0, tickSpacing: 1, tickLower, tickUpper,
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(tickLower).toString(),
    upperSqrtX64: TickUtil.getSqrtPriceAtTick(tickUpper).toString(),
    poolLiquidity: "1000000000000000",
    feeTierBps: 15,
    ...overrides,
  };
}

const linear = (rateA: bigint, rateB: bigint): OpenAllocateQuoteFn => async (side, spend) => ({
  spend, minOut: spend * (side === "A" ? rateA : rateB) / 1_000_000n,
});

describe("open-allocate modes", () => {
  it("defaults production to the current loop", () => {
    expect(OPEN_POSITION_ALLOCATE_MODE).toBe("loop");
    expect(parseOpenAllocateMode(undefined)).toBe("loop");
    expect(parseOpenAllocateMode("single-shot")).toBe("single-shot");
    expect(parseOpenAllocateMode("nope")).toBe("loop");
  });

  it("single-shot quotes once; loop stops on the first 1% match", async () => {
    const quote = vi.fn(linear(1_000_000n, 1_000_000n));
    const requested = 100_000_000n;
    const ss = await allocateOpenPosition({ pool: pool(), requested, mode: "single-shot", quote });
    expect(ss.rounds).toBe(1);
    expect(ss.quotes).toBe(2);
    expect(ss.converged).toBe(true);
    const loop = await allocateOpenPosition({ pool: pool(), requested, mode: "loop", quote });
    expect(loop.rounds).toBe(1);
    expect(loop.converged).toBe(true);
    expect(Math.abs(extraUnpairedPct(ss, loop))).toBeLessThan(0.05);
    expect(leftoverIsMateriallyWorse(ss, loop)).toBe(false);
  });

  it("loop requotes when Jupiter rates diverge from the pool price; leftover stays smaller", async () => {
    // A is 10% worse than B, so the first 50/50 split leaves A short.
    const quote = vi.fn(linear(900_000n, 1_000_000n));
    const requested = 100_000_000n;
    const first = poolPriceSpendA(pool(), requested);
    expect(first).toBeGreaterThan(40_000_000n);
    expect(first).toBeLessThan(60_000_000n);
    const ss = await allocateOpenPosition({ pool: pool(), requested, mode: "single-shot", quote });
    const loop = await allocateOpenPosition({ pool: pool(), requested, mode: "loop", quote });
    expect(loop.rounds).toBeGreaterThan(1);
    expect(loop.rounds).toBeLessThanOrEqual(ALLOCATE_MAX_ROUNDS);
    expect(loop.converged).toBe(true);
    expect(loop.spendA).toBeGreaterThan(ss.spendA);
    expect(loop.unpairedPct).toBeLessThan(ss.unpairedPct);
    expect(ss.mismatchPct).toBeGreaterThan(loop.mismatchPct);
  });

  it("sizes liquidity from minOut minus the 1% reserve on both paths", async () => {
    const quote = linear(1_000_000n, 1_000_000n);
    const ss = await allocateOpenPosition({
      pool: pool(), requested: 100_000_000n, mode: "single-shot", quote, toleranceBps: 100,
    });
    // Symmetric 1:1 quotes → leftover is almost entirely the 1% reserve.
    expect(ss.unpairedPct).toBeGreaterThan(0.9);
    expect(ss.unpairedPct).toBeLessThan(1.2);
    expect(ss.mismatchPct).toBeLessThan(0.05);
  });

  it("adjusted spendA moves off the raw pool-price split when the pool has a fee", () => {
    const raw = poolPriceSpendA(pool(), 100_000_000n);
    const adj = adjustedPoolPriceSpendA(pool(), 100_000_000n);
    expect(adj).not.toBe(raw);
  });

  it("adjusted spendA stays on the pool-price split when the impact would leave the range", () => {
    const thin = pool({ poolLiquidity: "1000" });
    const raw = poolPriceSpendA(thin, 100_000_000n);
    expect(adjustedPoolPriceSpendA(thin, 100_000_000n)).toBe(raw);
  });

  it("treats leftover above the material threshold as worse", () => {
    const loop = { unpairedPct: 1.0 } as never;
    const mild = { unpairedPct: 1.2 } as never;
    const bad = { unpairedPct: 1.0 + MATERIAL_LEFTOVER_PCT + 0.1 } as never;
    expect(leftoverIsMateriallyWorse(mild, loop)).toBe(false);
    expect(leftoverIsMateriallyWorse(bad, loop)).toBe(true);
  });
});
