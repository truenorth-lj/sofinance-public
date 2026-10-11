import BN from "bn.js";
import { CLMM_PROGRAM_ID, PoolInfoLayout, TickArrayLayout, TickUtil, getPdaTickArrayAddress } from "@raydium-io/raydium-sdk-v2";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { halfWindowBinsFor, readOnchainPoolLiquidity } from "./onchain-liquidity";

const pool = Keypair.generate().publicKey;
const mintA = Keypair.generate().publicKey;
const mintB = Keypair.generate().publicKey;

function account(data: Buffer, owner = CLMM_PROGRAM_ID): AccountInfo<Buffer> {
  return { data, owner, lamports: 1, executable: false };
}

function poolAccount(tickCurrent: number, tickSpacing: number, liquidity: bigint) {
  const buffer = Buffer.alloc(PoolInfoLayout.span);
  const state = PoolInfoLayout.decode(buffer);
  PoolInfoLayout.encode({
    ...state,
    mintA, mintB, mintDecimalsA: 6, mintDecimalsB: 8, tickSpacing, tickCurrent,
    liquidity: new BN(liquidity.toString()),
    sqrtPriceX64: TickUtil.getSqrtPriceAtTick(tickCurrent),
  }, buffer);
  return account(buffer);
}

function tickArrayAccount(startTickIndex: number, ticks: Array<{ tick: number; net: bigint }>, tickSpacing: number, poolKey = pool) {
  const buffer = Buffer.alloc(TickArrayLayout.span);
  const state = TickArrayLayout.decode(buffer);
  const slots = state.ticks.map((slot, index) => {
    const found = ticks.find((entry) => entry.tick === startTickIndex + index * tickSpacing);
    return found
      ? { ...slot, tick: found.tick, liquidityNet: new BN(found.net.toString()), liquidityGross: new BN((found.net < 0n ? -found.net : found.net).toString()) }
      : slot;
  });
  TickArrayLayout.encode({ ...state, poolId: poolKey, startTickIndex, ticks: slots }, buffer);
  return account(buffer);
}

function connection(accounts: Map<string, AccountInfo<Buffer>>): Connection {
  return {
    getAccountInfo: vi.fn(async (key: PublicKey) => accounts.get(key.toBase58()) ?? null),
    getMultipleAccountsInfo: vi.fn(async (keys: PublicKey[]) => keys.map((key) => accounts.get(key.toBase58()) ?? null)),
  } as unknown as Connection;
}

const arrayKey = (start: number) => getPdaTickArrayAddress(CLMM_PROGRAM_ID, pool, start).publicKey.toBase58();

describe("halfWindowBinsFor", () => {
  it("covers at least +-300 ticks and at least +-6 bins", () => {
    expect(halfWindowBinsFor(1)).toBe(300);
    expect(halfWindowBinsFor(10)).toBe(30);
    expect(halfWindowBinsFor(60)).toBe(6);
    expect(halfWindowBinsFor(120)).toBe(6);
  });
});

describe("readOnchainPoolLiquidity", () => {
  it("rebuilds the per-bin liquidity profile from the pool account and its tick arrays", async () => {
    // Two positions at spacing 60: [-46140, -45960) L=600 and [-46080, -46020) L=400 (L at the current bin = 1000).
    // The window (+-6 bins) spans the arrays starting at -50400 (left empty / missing) and -46800.
    const accounts = new Map<string, AccountInfo<Buffer>>([
      [pool.toBase58(), poolAccount(-46_068, 60, 1000n)],
      [arrayKey(-46_800), tickArrayAccount(-46_800, [
        { tick: -46_140, net: 600n }, { tick: -46_080, net: 400n }, { tick: -46_020, net: -400n }, { tick: -45_960, net: -600n },
      ], 60)],
    ]);
    const result = await readOnchainPoolLiquidity(pool.toBase58(), connection(accounts));
    expect(result).toMatchObject({
      mintA: mintA.toBase58(), mintB: mintB.toBase58(), decimalsA: 6, decimalsB: 8, tickSpacing: 60, tickCurrent: -46_068,
    });
    const at = (tick: number) => result.bins.find((bin) => bin.tick === tick)!.liquidity;
    expect(at(-46_080)).toBe(1000); // bin of the current tick
    expect(at(-46_140)).toBe(600);
    expect(at(-46_020)).toBe(600); // 1000 - 400 crossing -46020
    expect(at(-46_200)).toBe(0);
    expect(result.bins).toHaveLength(2 * 6 + 1);
  });

  it("treats a missing tick array as having no initialised ticks", async () => {
    const accounts = new Map([[pool.toBase58(), poolAccount(5, 60, 77n)]]);
    const result = await readOnchainPoolLiquidity(pool.toBase58(), connection(accounts));
    expect(new Set(result.bins.map((bin) => bin.liquidity))).toEqual(new Set([77]));
  });

  it("rejects accounts that are not Raydium CLMM pools", async () => {
    await expect(readOnchainPoolLiquidity(pool.toBase58(), connection(new Map()))).rejects.toThrow(/does not exist/);
    const foreign = account(poolAccount(0, 1, 1n).data, Keypair.generate().publicKey);
    await expect(readOnchainPoolLiquidity(pool.toBase58(), connection(new Map([[pool.toBase58(), foreign]])))).rejects.toThrow(/does not exist/);
  });

  it("rejects a tick array that belongs to another pool", async () => {
    const accounts = new Map([
      [pool.toBase58(), poolAccount(0, 60, 1n)],
      [arrayKey(0), tickArrayAccount(0, [], 60, Keypair.generate().publicKey)],
    ]);
    await expect(readOnchainPoolLiquidity(pool.toBase58(), connection(accounts))).rejects.toThrow(/mismatch/);
  });
});
