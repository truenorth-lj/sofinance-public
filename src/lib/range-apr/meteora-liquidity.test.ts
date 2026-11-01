import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { meteoraBinArrayAddress } from "@sofinance/engine/protocols/meteora/accounts";
import { CBBTC_MINT, WBTC_WORMHOLE_MINT } from "@sofinance/engine/protocols/meteora/constants";
import { amountsPerLiquidity } from "./clmm-liquidity";
import { METEORA_POOL, fakeMeteoraConnection, meteoraAccounts } from "./meteora-chain.fixture";
import { binSqrtPriceX64, binTick, binTickSqrtPriceX64, dlmmBinLiquidity, existingBinRange, readMeteoraPoolLiquidity } from "./meteora-liquidity";
import { sqrtPriceAtTick } from "@sofinance/engine/range-apr/tick-math";

const poolBytes = () => Buffer.from(meteoraAccounts()[METEORA_POOL]!.data, "base64");
const withPool = (data: Buffer) => fakeMeteoraConnection(meteoraAccounts({ [METEORA_POOL]: { ...meteoraAccounts()[METEORA_POOL]!, data: data.toString("base64") } })).connection;

describe("readMeteoraPoolLiquidity (captured mainnet cbBTC/WBTC accounts)", () => {
  it("reads state, bin arrays and the liquidity distribution around the active bin", async () => {
    const { connection, calls } = fakeMeteoraConnection();
    const chain = await readMeteoraPoolLiquidity(METEORA_POOL, connection);
    expect(chain).toMatchObject({
      poolId: METEORA_POOL, mintA: CBBTC_MINT, mintB: WBTC_WORMHOLE_MINT, decimalsA: 8, decimalsB: 8,
      tickSpacing: 1, tickCurrent: 16,
      state: {
        binStep: 1, activeId: 16, status: 0, baseFeeRate: 100_000, variableFeeRate: 0, protocolShare: 1000,
        freezeAuthorityX: true, freezeAuthorityY: false, slot: 462945365,
        existingBinRange: { lowerBinId: -210, upperBinId: 349 },
        windowReserveX: "216691663", windowReserveY: "194193145",
      },
    });
    // Two reads: the LbPair, then both mints + 10 bin arrays in one batch.
    expect(calls).toHaveLength(2);
    expect(calls[1]).toHaveLength(12);
    expect(chain.state.binArrays.map((array) => [array.index, array.exists, array.inBitmap, array.nonEmptyBins])).toEqual([
      [-5, false, false, 0], [-4, false, false, 0], [-3, true, false, 0], [-2, true, false, 0], [-1, true, true, 60],
      [0, true, true, 70], [1, true, true, 9], [2, true, false, 0], [3, true, true, 0], [4, true, false, 0],
    ]);
    // ±300 one-bin ticks; the active bin is priced exactly like tick 16.
    expect(chain.bins).toHaveLength(601);
    expect(chain.bins[0]!.tick).toBe(-284);
    expect(chain.bins.at(-1)!.tick).toBe(316);
    expect(Number(BigInt(chain.sqrtPriceX64)) / 2 ** 64).toBeCloseTo(sqrtPriceAtTick(16), 12);
    expect(chain.bins.find((bin) => bin.tick === 16)!.liquidity).toBeCloseTo(dlmmBinLiquidity(350n, 6_535_090n, 16, 1), 0);
    expect(chain.bins.every((bin) => bin.liquidity >= 0)).toBe(true);
    expect(chain.bins.filter((bin) => bin.liquidity > 0)).toHaveLength(139);
    expect(chain.bins.map((bin) => Math.round(bin.liquidity))).toMatchSnapshot();
  });

  it("maps a bin's value onto the tick-L that holds the same value in that tick", () => {
    const L = dlmmBinLiquidity(0n, 1_000_000n, 5, 1);
    const { b: amountB } = amountsPerLiquidity(sqrtPriceAtTick(10), sqrtPriceAtTick(5), sqrtPriceAtTick(6));
    expect(L * amountB).toBeCloseTo(1_000_000, 3);
    expect(dlmmBinLiquidity(0n, 0n, 5, 1)).toBe(0);
    expect(binSqrtPriceX64(0, 1)).toBe((2n ** 64n).toString());
  });

  it("treats a missing bin array as empty and closes the existing range around the active bin", async () => {
    const zero = meteoraBinArrayAddress(METEORA_POOL, -1);
    const chain = await readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [zero]: null })).connection);
    expect(chain.state.binArrays[4]).toMatchObject({ index: -1, exists: false, nonEmptyBins: 0 });
    expect(chain.state.existingBinRange).toEqual({ lowerBinId: 0, upperBinId: 349 });
    expect(chain.bins.filter((bin) => bin.tick < 0 && bin.liquidity > 0)).toHaveLength(0);
    const active = meteoraBinArrayAddress(METEORA_POOL, 0);
    expect((await readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [active]: null })).connection)).state.existingBinRange).toBeNull();
    expect(existingBinRange([], 0)).toBeNull();
  });

  it("refuses non-allowlisted pools without any RPC call", async () => {
    const { connection, calls } = fakeMeteoraConnection();
    await expect(readMeteoraPoolLiquidity("8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh", connection)).rejects.toThrow(/allowlisted/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a pool with the wrong owner, mints, bin step or status", async () => {
    const accounts = meteoraAccounts();
    const wrongOwner = { ...accounts[METEORA_POOL]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" };
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [METEORA_POOL]: wrongOwner })).connection))
      .rejects.toThrow(/does not exist/);
    const badMint = poolBytes(); badMint[88]! ^= 1;
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, withPool(badMint))).rejects.toThrow(/mint mismatch/);
    const badStep = poolBytes(); badStep.writeUInt16LE(10, 80);
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, withPool(badStep))).rejects.toThrow(/bin step mismatch/);
    const disabled = poolBytes(); disabled[82] = 1;
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, withPool(disabled))).rejects.toThrow(/disabled/);
  });

  it("rejects a bin array that belongs to another index or program, and a mint on another token program", async () => {
    const accounts = meteoraAccounts();
    const first = meteoraBinArrayAddress(METEORA_POOL, -3), second = meteoraBinArrayAddress(METEORA_POOL, -2);
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [first]: accounts[second]! })).connection))
      .rejects.toThrow(/index mismatch/);
    const foreign = { ...accounts[first]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" };
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [first]: foreign })).connection))
      .rejects.toThrow(/owner mismatch/);
    const t22 = { ...accounts[CBBTC_MINT]!, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };
    await expect(readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [CBBTC_MINT]: t22 })).connection))
      .rejects.toThrow(/token program mismatch/);
  });

  describe("bin steps above 1 (scan-found pools passed with their spec)", () => {
    const spec = (binStep: number) => ({ poolAddress: METEORA_POOL, mintX: CBBTC_MINT, mintY: WBTC_WORMHOLE_MINT, binStep });
    const withStep = (binStep: number) => { const data = poolBytes(); data.writeUInt16LE(binStep, 80); return withPool(data); };

    it("maps bin b onto tick bin [b*s, (b+1)*s) around the active bin, with the window in bins", async () => {
      const chain = await readMeteoraPoolLiquidity(METEORA_POOL, withStep(10), spec(10));
      expect(chain).toMatchObject({ tickSpacing: 10, tickCurrent: 160, state: { binStep: 10, activeId: 16 } });
      // max(6, ceil(300 / 10)) = 30 bins either side of the active bin.
      expect(chain.bins).toHaveLength(61);
      expect(chain.bins[0]!.tick).toBe(binTick(16 - 30, 10));
      expect(chain.bins.at(-1)!.tick).toBe(binTick(16 + 30, 10));
      expect(chain.bins.every((bin) => bin.tick % 10 === 0)).toBe(true);
      expect(chain.sqrtPriceX64).toBe(binTickSqrtPriceX64(16, 10));
      expect(chain.bins.find((bin) => bin.tick === 160)!.liquidity).toBeCloseTo(dlmmBinLiquidity(350n, 6_535_090n, 16, 10), 0);
      expect(chain.state.binArrays.map((array) => array.index)).toEqual([-1, 0]);
    });

    it("keeps the bin's value: L over its s-tick width holds the same raw Y", () => {
      for (const binStep of [2, 5, 10]) {
        const L = dlmmBinLiquidity(0n, 1_000_000n, 5, binStep);
        const { b } = amountsPerLiquidity(sqrtPriceAtTick(1_000), sqrtPriceAtTick(binTick(5, binStep)), sqrtPriceAtTick(binTick(6, binStep)));
        expect(L * b).toBeCloseTo(1_000_000, 3);
      }
      // Bin step 1 is unchanged: tick == bin and the sqrt price is the bin's own.
      expect(binTick(-7, 1)).toBe(-7);
      expect(binTickSqrtPriceX64(1234, 1)).toBe(binSqrtPriceX64(1234, 1));
    });

    it("keeps the anchored error small: a bin's real width vs its s ticks differs by < 0.05% for s <= 10", () => {
      for (const binStep of [2, 5, 10]) {
        const realTicks = Math.log(1 + binStep / 10_000) / Math.log(1.0001);
        expect(Math.abs(realTicks - binStep) / binStep).toBeLessThan(0.0005);
      }
    });

    it("refuses bin step > 10 and a spec for another pool without any RPC call", async () => {
      const { connection, calls } = fakeMeteoraConnection();
      await expect(readMeteoraPoolLiquidity(METEORA_POOL, connection, spec(80))).rejects.toThrow(/bin step 1-10 only/);
      await expect(readMeteoraPoolLiquidity(METEORA_POOL, connection, { ...spec(1), poolAddress: "8k2c9Kiavx5pbWc2dmzhL7vFp11sLgMcKFfSueq8haAh" })).rejects.toThrow(/allowlisted/);
      expect(calls).toHaveLength(0);
    });

    it("checks the spec's bin step against the chain, and accepts Token-2022 mints when the spec pins no program", async () => {
      await expect(readMeteoraPoolLiquidity(METEORA_POOL, withStep(5), spec(10))).rejects.toThrow(/bin step mismatch/);
      const accounts = meteoraAccounts();
      const t22 = { ...accounts[CBBTC_MINT]!, owner: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" };
      const chain = await readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [CBBTC_MINT]: t22 })).connection, spec(1));
      expect(chain.tickCurrent).toBe(16);
      const foreign = { ...accounts[CBBTC_MINT]!, owner: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK" };
      await expect(readMeteoraPoolLiquidity(METEORA_POOL, fakeMeteoraConnection(meteoraAccounts({ [CBBTC_MINT]: foreign })).connection, spec(1)))
        .rejects.toThrow(/token program mismatch/);
    });
  });
});
