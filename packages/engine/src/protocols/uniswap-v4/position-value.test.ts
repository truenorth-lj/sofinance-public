import { describe, expect, it, vi } from "vitest";
import { UNIV4_RHC, UNIV4_RHC_ALLOWLISTED_POOLS } from "./constants";
import { amountsForLiquidityFloor, MAX_POSITION_VALUES, positionSalt, readPositionValues, unclaimedFee } from "./position-value";
import { amountsForLiquidity, Q96, sqrtPriceAtTick } from "./tick-math";

const POOL = UNIV4_RHC_ALLOWLISTED_POOLS[0]!;
const key = { currency0: POOL.currency0.address, currency1: POOL.currency1.address, fee: POOL.fee, tickSpacing: POOL.tickSpacing, hooks: POOL.hooks };
const UNLISTED = { ...key, hooks: "0x000000000000000000000000000000000000dEaD" as const };
// PositionInfo | poolId 200 | tickUpper 24 | tickLower 24 | hasSubscriber 8 |
const info = (lower: number, upper: number) => (BigInt(upper & 0xffffff) << 32n) | (BigInt(lower & 0xffffff) << 8n);
const success = (result: unknown) => ({ status: "success" as const, result });
const failure = { status: "failure" as const, error: new Error("revert") };

describe("unclaimedFee (v4 Position: (inside − last) mod 2^256 × liquidity / 2^128)", () => {
  it("plain growth, and growth that wrapped past 2^256", () => {
    const Q128 = 1n << 128n;
    expect(unclaimedFee(10n ** 18n, 5n * Q128, 2n * Q128)).toBe(3n * 10n ** 18n);
    expect(unclaimedFee(1000n, Q128, (1n << 256n) - Q128)).toBe(2000n); // inside wrapped past 2^256
    expect(unclaimedFee(1000n, 0n, 0n)).toBe(0n);
  });
});

describe("amountsForLiquidityFloor", () => {
  it("in range: never more than the mint-side (rounded up) amounts, at most 1 unit less", () => {
    const [lo, hi, p] = [sqrtPriceAtTick(-100), sqrtPriceAtTick(100), Q96];
    const down = amountsForLiquidityFloor(10n ** 20n, p, lo, hi), up = amountsForLiquidity(10n ** 20n, p, lo, hi);
    expect(up.amount0 - down.amount0).toBeGreaterThanOrEqual(0n); expect(up.amount0 - down.amount0).toBeLessThanOrEqual(1n);
    expect(up.amount1 - down.amount1).toBeGreaterThanOrEqual(0n); expect(up.amount1 - down.amount1).toBeLessThanOrEqual(1n);
  });
  it("below range is all token0, above range all token1", () => {
    const [lo, hi] = [sqrtPriceAtTick(-100), sqrtPriceAtTick(100)];
    expect(amountsForLiquidityFloor(10n ** 20n, sqrtPriceAtTick(-200), lo, hi).amount1).toBe(0n);
    expect(amountsForLiquidityFloor(10n ** 20n, sqrtPriceAtTick(200), lo, hi).amount0).toBe(0n);
  });
});

describe("readPositionValues (two read-only multicalls)", () => {
  it("amounts at the pool price and unclaimed fees per NFT; unlisted or missing NFTs are left out; reads use the PositionManager salt", async () => {
    const Q128 = 1n << 128n;
    const multicall = vi.fn()
      .mockResolvedValueOnce([
        success(10n ** 20n), success([key, info(-123, 77)]), // #9
        success(5n), success([UNLISTED, info(-1, 1)]), // #7 unlisted pool
        failure, failure, // #6 burned
      ])
      .mockResolvedValueOnce([
        success([Q96, 0, 0, 0]),
        success([7n * Q128, 3n * Q128]), success([10n ** 20n, 2n * Q128, 3n * Q128]),
      ]);
    const values = await readPositionValues({ multicall } as never, [9n, 7n, 6n, 9n]);
    const expected = amountsForLiquidityFloor(10n ** 20n, Q96, sqrtPriceAtTick(-123), sqrtPriceAtTick(77));
    expect(values).toEqual([{ tokenId: "9", poolId: POOL.poolId, amount0: expected.amount0.toString(), amount1: expected.amount1.toString(),
      fees0: (5n * 10n ** 20n).toString(), fees1: "0" }]);
    const second = multicall.mock.calls[1]![0].contracts as { functionName: string; args: unknown[]; address: string }[];
    expect(second.map((c) => c.functionName)).toEqual(["getSlot0", "getFeeGrowthInside", "getPositionInfo"]);
    expect(second.every((c) => c.address === UNIV4_RHC.stateView)).toBe(true);
    expect(second[2]!.args).toEqual([POOL.poolId, UNIV4_RHC.positionManager, -123, 77, positionSalt(9n)]);
    expect(positionSalt(9n)).toBe(`0x${"0".repeat(63)}9`);
  });

  it("a failed StateView read leaves that field null (a dash), never zero", async () => {
    const multicall = vi.fn()
      .mockResolvedValueOnce([success(1000n), success([key, info(-10, 10)])])
      .mockResolvedValueOnce([failure, success([0n, 0n]), failure]);
    expect(await readPositionValues({ multicall } as never, [1n])).toEqual([{ tokenId: "1", poolId: POOL.poolId, amount0: null, amount1: null, fees0: null, fees1: null }]);
  });

  it("an unreachable RPC (every entry failed, not a revert) throws instead of looking like no positions", async () => {
    const down = { status: "failure" as const, error: new Error("HTTP request failed. Status: 502") };
    const multicall = vi.fn().mockResolvedValueOnce([down, down]);
    await expect(readPositionValues({ multicall } as never, [1n])).rejects.toThrow("502");
    const burned = vi.fn().mockResolvedValueOnce([failure, failure]);
    expect(await readPositionValues({ multicall: burned } as never, [1n])).toEqual([]);
  });

  it(`reads at most ${MAX_POSITION_VALUES} ids and makes no call for none`, async () => {
    const multicall = vi.fn().mockResolvedValue([]);
    expect(await readPositionValues({ multicall } as never, [])).toEqual([]);
    expect(multicall).not.toHaveBeenCalled();
    await readPositionValues({ multicall } as never, Array.from({ length: 15 }, (_, i) => BigInt(i + 1)));
    expect(multicall.mock.calls[0]![0].contracts).toHaveLength(MAX_POSITION_VALUES * 2);
  });
});
