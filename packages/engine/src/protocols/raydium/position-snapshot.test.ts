import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CLMM_PROGRAM_ID,
  getPdaPersonalPositionAddress,
  getPdaTickArrayAddress,
  LiquidityMathUtil,
  PersonalPositionLayout,
  PoolInfoLayout,
  TickArrayLayout,
  TickArrayUtil,
  TickLayout,
  TickUtil,
} from "@raydium-io/raydium-sdk-v2";
import { Keypair, PublicKey, type AccountInfo, type Connection } from "@solana/web3.js";
import { readRaydiumPositionAccounts, readRaydiumUncollectedFees } from "./position-snapshot";

const key = () => Keypair.generate().publicKey;
const nft = key();
const pool = key();
const mintA = key();
const mintB = key();
const vaultA = key();
const vaultB = key();
const position = getPdaPersonalPositionAddress(CLMM_PROGRAM_ID, nft).publicKey;
const accounts = new Map<string, AccountInfo<Buffer>>();
const info = (data: Buffer, owner = CLMM_PROGRAM_ID) => ({ data, owner, executable: false, lamports: 1, rentEpoch: 0 });

function positionData() {
  const data = Buffer.alloc(PersonalPositionLayout.span);
  createHash("sha256").update("account:PersonalPositionState").digest().copy(data, 0, 0, 8);
  nft.toBuffer().copy(data, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(data, PersonalPositionLayout.offsetOf("poolId"));
  data.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  data.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  data.writeBigUInt64LE(10000n, PersonalPositionLayout.offsetOf("liquidity"));
  data.writeBigUInt64LE(17n, PersonalPositionLayout.offsetOf("tokenFeesOwedA"));
  return data;
}

function poolData() {
  const data = Buffer.alloc(PoolInfoLayout.span);
  createHash("sha256").update("account:PoolState").digest().copy(data, 0, 0, 8);
  for (const [field, value] of [["mintA", mintA], ["mintB", mintB], ["vaultA", vaultA], ["vaultB", vaultB]] as const) {
    value.toBuffer().copy(data, PoolInfoLayout.offsetOf(field));
  }
  data[PoolInfoLayout.offsetOf("mintDecimalsA")] = 6;
  data[PoolInfoLayout.offsetOf("mintDecimalsB")] = 6;
  data.writeUInt16LE(1, PoolInfoLayout.offsetOf("tickSpacing"));
  TickUtil.getSqrtPriceAtTick(0).toArrayLike(Buffer, "le", 16).copy(data, PoolInfoLayout.offsetOf("sqrtPriceX64"));
  return data;
}

function tickArray(start: number) {
  const data = Buffer.alloc(TickArrayLayout.span);
  pool.toBuffer().copy(data, TickArrayLayout.offsetOf("poolId"));
  data.writeInt32LE(start, TickArrayLayout.offsetOf("startTickIndex"));
  for (const tick of [-100, 100]) {
    if (TickArrayUtil.getTickArrayStartIndex(tick, 1) !== start) continue;
    data.writeInt32LE(tick, TickArrayLayout.offsetOf("ticks") + TickArrayUtil.getTickOffsetInArray(tick, 1) * TickLayout.span);
  }
  return info(data);
}

const accountRead = vi.fn(async (address: PublicKey, commitment?: string) => {
  void commitment;
  return accounts.get(address.toBase58()) ?? null;
});
const tickRead = vi.fn(async (keys: PublicKey[], commitment?: string) => {
  void commitment;
  return keys.map((item) => accounts.get(item.toBase58()) ?? null);
});
const connection = { getAccountInfo: accountRead, getMultipleAccountsInfo: tickRead } as unknown as Connection;

function seed() {
  accounts.clear();
  accountRead.mockClear();
  tickRead.mockClear();
  accounts.set(position.toBase58(), info(positionData()));
  accounts.set(pool.toBase58(), info(poolData()));
  for (const tick of [-100, 100]) {
    const start = TickArrayUtil.getTickArrayStartIndex(tick, 1);
    const pda = getPdaTickArrayAddress(CLMM_PROGRAM_ID, pool, start).publicKey;
    accounts.set(pda.toBase58(), tickArray(start));
  }
}

describe("Raydium position snapshot", () => {
  it("reads the position and pool with the same round-down amounts and owed fees", async () => {
    seed();
    const snapshot = await readRaydiumPositionAccounts(nft.toBase58(), connection);
    const decoded = PersonalPositionLayout.decode(positionData());
    const poolAccount = PoolInfoLayout.decode(poolData());
    const lower = TickUtil.getSqrtPriceAtTick(-100);
    const upper = TickUtil.getSqrtPriceAtTick(100);
    const amounts = LiquidityMathUtil.getAmountsForLiquidity(poolAccount.sqrtPriceX64, lower, upper, decoded.liquidity, false);
    expect(snapshot.positionAccount).toBe(position.toBase58());
    expect(snapshot.poolId).toBe(pool.toBase58());
    expect(snapshot.mintA).toBe(mintA.toBase58());
    expect(snapshot.mintB).toBe(mintB.toBase58());
    expect(snapshot.vaultA).toBe(vaultA.toBase58());
    expect(snapshot.vaultB).toBe(vaultB.toBase58());
    expect(snapshot.tickLower).toBe(-100);
    expect(snapshot.tickUpper).toBe(100);
    expect(snapshot.liquidity).toBe("10000");
    expect(snapshot.rangeSide).toBe("inside");
    expect(snapshot.amountA).toBe(BigInt(amounts.amountA.toString()));
    expect(snapshot.amountB).toBe(BigInt(amounts.amountB.toString()));
    expect(snapshot.tokenFeesOwedA).toBe(17n);
    expect(snapshot.tokenFeesOwedB).toBe(0n);
    expect(snapshot.stateFingerprint).toBe(createHash("sha256").update(positionData()).digest("hex"));
    expect(accountRead).toHaveBeenCalledTimes(2);
    expect(accountRead.mock.calls[0]?.[1]).toBe("confirmed");

    const fees = await readRaydiumUncollectedFees(connection, snapshot);
    expect(fees).toEqual({ a: 17n, b: 0n });
    expect(tickRead).toHaveBeenCalledTimes(1);
    expect(tickRead.mock.calls[0]?.[1]).toBe("confirmed");
  });

  it("rejects a missing position, a mint mismatch, and a missing pool before any tick read", async () => {
    seed();
    accounts.delete(position.toBase58());
    await expect(readRaydiumPositionAccounts(nft.toBase58(), connection)).rejects.toThrow("Raydium CLMM personal position account not found for this NFT mint");

    seed();
    const swapped = positionData();
    key().toBuffer().copy(swapped, PersonalPositionLayout.offsetOf("nftMint"));
    accounts.set(position.toBase58(), info(swapped));
    await expect(readRaydiumPositionAccounts(nft.toBase58(), connection)).rejects.toThrow("Position NFT mint mismatch");

    seed();
    accounts.delete(pool.toBase58());
    await expect(readRaydiumPositionAccounts(nft.toBase58(), connection)).rejects.toThrow("Pool account missing or not a Raydium CLMM pool");
    expect(tickRead).not.toHaveBeenCalled();
  });

  it("rejects a tick array that does not belong to the pool", async () => {
    seed();
    const snapshot = await readRaydiumPositionAccounts(nft.toBase58(), connection);
    const start = TickArrayUtil.getTickArrayStartIndex(-100, 1);
    const pda = getPdaTickArrayAddress(CLMM_PROGRAM_ID, pool, start).publicKey;
    const foreign = tickArray(start);
    key().toBuffer().copy(foreign.data, TickArrayLayout.offsetOf("poolId"));
    accounts.set(pda.toBase58(), foreign);
    await expect(readRaydiumUncollectedFees(connection, snapshot)).rejects.toThrow("Tick array does not match pool or start index");
  });
});
