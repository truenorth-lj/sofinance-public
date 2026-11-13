import { describe, expect, it } from "vitest";
import { SqrtPriceMath, TickUtil } from "@raydium-io/raydium-sdk-v2";
import BN from "bn.js";
import { projectTargetPoolSqrt, type ProjectTargetPoolSqrtInput, TargetPoolProjectionError } from "./target-pool-projection";

const poolId = "Pool111111111111111111111111111111111111111";
const mintA = "MintA11111111111111111111111111111111111111";
const mintB = "MintB11111111111111111111111111111111111111";
const otherPool = "Other11111111111111111111111111111111111111";
const tickCurrent = 46069;
const tickSpacing = 60;
const start = TickUtil.getSqrtPriceAtTick(tickCurrent).add(TickUtil.getSqrtPriceAtTick(tickCurrent + 1)).divn(2);
const liquidity = new BN("1000000000000");

function hop(opts: { inAmount: string; zeroForOne?: boolean; bps?: number; ammKey?: string }) {
  const zeroForOne = opts.zeroForOne ?? true;
  return {
    routePlan: [{
      bps: opts.bps ?? 10_000,
      swapInfo: {
        ammKey: opts.ammKey ?? poolId,
        inputMint: zeroForOne ? mintA : mintB,
        outputMint: zeroForOne ? mintB : mintA,
        inAmount: opts.inAmount,
      },
    }],
  };
}

function input(overrides: Partial<ProjectTargetPoolSqrtInput> = {}): ProjectTargetPoolSqrtInput {
  return {
    poolId, mintA, mintB,
    sqrtPriceX64: start.toString(),
    poolLiquidity: liquidity.toString(),
    tickCurrent, tickSpacing,
    lowerSqrtX64: TickUtil.getSqrtPriceAtTick(40_000).toString(),
    upperSqrtX64: TickUtil.getSqrtPriceAtTick(50_000).toString(),
    rangeSide: "inside",
    routes: [],
    complexError: () => new TargetPoolProjectionError("complex"),
    rangeError: () => new TargetPoolProjectionError("range"),
    bandError: () => new TargetPoolProjectionError("band"),
    ...overrides,
  };
}

describe("projectTargetPoolSqrt", () => {
  it("returns the starting price when no hop touches the target pool", () => {
    expect(projectTargetPoolSqrt(input()).toString()).toBe(start.toString());
    expect(projectTargetPoolSqrt(input({ routes: [hop({ inAmount: "1", ammKey: otherPool })] })).toString()).toBe(start.toString());
  });

  it("projects a single 100% target-pool hop with the same next-sqrt math both callers used", () => {
    const routes = [hop({ inAmount: "1000" })];
    const expected = SqrtPriceMath.getNextSqrtPriceFromInput(start, liquidity, new BN("1000"), true);
    expect(projectTargetPoolSqrt(input({ routes })).toString()).toBe(expected.toString());
  });

  it("lets each caller supply its own complex / range / band errors", () => {
    expect(() => projectTargetPoolSqrt(input({ routes: [hop({ inAmount: "1", bps: 5_000 })] })))
      .toThrow(new TargetPoolProjectionError("complex"));
    expect(() => projectTargetPoolSqrt(input({
      routes: [hop({ inAmount: "1" }), hop({ inAmount: "1" })],
    }))).toThrow("complex");
    expect(() => projectTargetPoolSqrt(input({ rangeSide: "below" }))).toThrow("range");
  });

  it("rejects a target-pool hop whose assets are not the pool tokens", () => {
    expect(() => projectTargetPoolSqrt(input({
      routes: [{
        routePlan: [{
          bps: 10_000,
          swapInfo: { ammKey: poolId, inputMint: mintA, outputMint: "MintC11111111111111111111111111111111111111", inAmount: "1" },
        }],
      }],
    }))).toThrow("Target pool route asset mismatch");
  });

  it("throws the caller's band error when the hop would leave the current tick-spacing band", () => {
    const upperBand = TickUtil.getSqrtPriceAtTick(tickSpacingBandUpper(tickCurrent, tickSpacing));
    // Search for a one-for-zero amount that reaches the exclusive upper band edge while staying in a wide range.
    let lo = 1n;
    let hi = 10n ** 18n;
    let found: string | null = null;
    for (let i = 0; i < 80; i++) {
      const mid = (lo + hi) / 2n;
      const next = SqrtPriceMath.getNextSqrtPriceFromInput(start, liquidity, new BN(mid.toString()), false);
      if (next.gte(upperBand)) {
        found = mid.toString();
        hi = mid - 1n;
      } else {
        lo = mid + 1n;
      }
    }
    expect(found).not.toBeNull();
    expect(() => projectTargetPoolSqrt(input({ routes: [hop({ inAmount: found!, zeroForOne: false })] })))
      .toThrow(new TargetPoolProjectionError("band"));
  });
});

function tickSpacingBandUpper(tick: number, spacing: number) {
  return Math.floor(tick / spacing) * spacing + spacing;
}
