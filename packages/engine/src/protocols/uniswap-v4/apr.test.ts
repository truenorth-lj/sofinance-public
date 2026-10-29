import { describe, expect, it } from "vitest";
import fixture from "../../fixtures/univ4-rhc-spcx-live.json";
import { amountsForLiquidity, estimateUniv4Apr, liquidityByRange, swapFeeInToken0, type SwapSample } from "./apr";

const swaps: SwapSample[] = fixture.history.swaps.map(swap => ({
  blockNumber: BigInt(swap.blockNumber), amount0: BigInt(swap.amount0), amount1: BigInt(swap.amount1), liquidity: BigInt(swap.liquidity), tick: swap.tick, fee: swap.fee,
}));
const ranges = fixture.history.ranges.map(range => ({ ...range, liquidity: BigInt(range.liquidity) }));

describe("uniswap v4 APR estimate", () => {
  it("charges the fee on the swapper's input side", () => {
    expect(swapFeeInToken0({ blockNumber: 1n, amount0: -1_000_000n, amount1: 999_000n, liquidity: 1n, tick: 0, fee: 50 }, 1)).toBeCloseTo(50, 9);
    expect(swapFeeInToken0({ blockNumber: 1n, amount0: 999_000n, amount1: -2_000_000n, liquidity: 1n, tick: 0, fee: 100 }, 2)).toBeCloseTo(100, 9);
  });

  it("nets liquidity per range and drops closed ranges", () => {
    expect(liquidityByRange([
      { tickLower: -1, tickUpper: 1, liquidityDelta: 10n }, { tickLower: 0, tickUpper: 5, liquidityDelta: 3n },
      { tickLower: -1, tickUpper: 1, liquidityDelta: -10n }, { tickLower: 0, tickUpper: 5, liquidityDelta: 2n },
    ])).toEqual([{ tickLower: 0, tickUpper: 5, liquidity: 5n }]);
  });

  it("values liquidity like v4 (below, inside, above range)", () => {
    const below = amountsForLiquidity(1e18, 0, 10, Math.pow(1.0001, -1));
    expect(below.amount1).toBe(0);
    const above = amountsForLiquidity(1e18, -10, 0, Math.pow(1.0001, 1));
    expect(above.amount0).toBe(0);
    const inside = amountsForLiquidity(1e18, -10, 10, 1);
    expect(inside.amount0).toBeCloseTo(inside.amount1, -10);
  });

  it("reproduces the recorded SPCX/SPCXon estimate (token0 units, no USD)", () => {
    const estimate = estimateUniv4Apr({
      swaps, ranges, sqrtPriceX96: BigInt(fixture.state.slot0.sqrtPriceX96), tick: fixture.state.slot0.tick,
      toBlock: BigInt(fixture.history.scannedTo), initBlock: 98425782n, blocksPerSecond: 9.6108919, decimals0: 18, decimals1: 18,
    });
    expect(estimate.unit).toBe("token0");
    expect(estimate.activeLiquidityFromRanges).toBe(fixture.state.liquidity);
    expect(estimate.tvl.valueToken0).toBeCloseTo(338.874, 2);
    const [day, week] = estimate.windows;
    expect(day).toMatchObject({ label: "24h", coveredSeconds: 86_400, swapCount: 3 });
    expect(week).toMatchObject({ label: "7d", swapCount: 5 });
    expect(week!.coveredSeconds).toBeCloseTo(236_744, -1);
    expect(week!.feesToken0).toBeCloseTo(0.0000137391, 9);
    expect(day!.poolFeeAprPct).toBeCloseTo(0.001407, 5);
    expect(week!.poolFeeAprPct).toBeCloseTo(0.00054, 5);
    expect(estimate.rangeAprs.map(range => [range.tickLower, range.tickUpper])).toEqual([[-2, 0], [-11, 9], [-61, 59]]);
    // Narrower ranges earn more per unit of capital.
    const aprs = estimate.rangeAprs.map(range => range.aprPct!);
    expect(aprs[0]).toBeGreaterThan(aprs[1]!);
    expect(aprs[1]).toBeGreaterThan(aprs[2]!);
  });

  it("returns null APR without liquidity or elapsed time", () => {
    const estimate = estimateUniv4Apr({ swaps: [], ranges: [], sqrtPriceX96: 2n ** 96n, tick: 0, toBlock: 10n, initBlock: 10n, blocksPerSecond: 10, decimals0: 18, decimals1: 18 });
    expect(estimate.windows.map(window => window.poolFeeAprPct)).toEqual([null, null]);
    expect(estimate.rangeAprs.every(range => range.aprPct === null)).toBe(true);
  });
});
