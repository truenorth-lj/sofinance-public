import { describe, expect, it } from "vitest";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import {
  aggregateCashflowsForPosition,
  CREATE_PERSONAL_POSITION_DISC,
  DECREASE_LIQUIDITY_DISC,
  decodeRaydiumLiquidityEvent,
  INCREASE_LIQUIDITY_DISC,
  parseRaydiumEventsFromLogs,
} from "./position-performance-events";

function writeU128(buf: Buffer, offset: number, value: bigint) {
  buf.writeBigUInt64LE(value & ((1n << 64n) - 1n), offset);
  buf.writeBigUInt64LE(value >> 64n, offset + 8);
}

function encodeCreate(pool: PublicKey, owner: PublicKey, amountA: bigint, amountB: bigint, liquidity: bigint) {
  const buf = Buffer.alloc(8 + 32 * 3 + 4 + 4 + 16 + 8 * 4);
  CREATE_PERSONAL_POSITION_DISC.copy(buf, 0);
  let o = 8;
  pool.toBuffer().copy(buf, o); o += 32;
  owner.toBuffer().copy(buf, o); o += 32; // minter
  owner.toBuffer().copy(buf, o); o += 32;
  buf.writeInt32LE(-100, o); o += 4;
  buf.writeInt32LE(100, o); o += 4;
  writeU128(buf, o, liquidity); o += 16;
  buf.writeBigUInt64LE(amountA, o); o += 8;
  buf.writeBigUInt64LE(amountB, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeBigUInt64LE(0n, o);
  return buf;
}

function encodeIncrease(nft: PublicKey, amountA: bigint, amountB: bigint, liquidity: bigint) {
  const buf = Buffer.alloc(8 + 32 + 16 + 8 * 4);
  INCREASE_LIQUIDITY_DISC.copy(buf, 0);
  let o = 8;
  nft.toBuffer().copy(buf, o); o += 32;
  writeU128(buf, o, liquidity); o += 16;
  buf.writeBigUInt64LE(amountA, o); o += 8;
  buf.writeBigUInt64LE(amountB, o); o += 8;
  buf.writeBigUInt64LE(0n, o); o += 8;
  buf.writeBigUInt64LE(0n, o);
  return buf;
}

function encodeDecrease(nft: PublicKey, principalA: bigint, principalB: bigint, feeA: bigint, feeB: bigint) {
  const buf = Buffer.alloc(8 + 32 + 16 + 8 * 4 + 8 * 3 + 8 * 2);
  DECREASE_LIQUIDITY_DISC.copy(buf, 0);
  let o = 8;
  nft.toBuffer().copy(buf, o); o += 32;
  writeU128(buf, o, 5n); o += 16;
  buf.writeBigUInt64LE(principalA, o); o += 8;
  buf.writeBigUInt64LE(principalB, o); o += 8;
  buf.writeBigUInt64LE(feeA, o); o += 8;
  buf.writeBigUInt64LE(feeB, o); o += 8;
  // rewards[3] + transfer fees
  for (let i = 0; i < 5; i++) {
    buf.writeBigUInt64LE(0n, o);
    o += 8;
  }
  return buf;
}

describe("position-performance-events", () => {
  const pool = PublicKey.unique();
  const owner = PublicKey.unique();
  const nft = PublicKey.unique();
  const otherNft = PublicKey.unique();

  it("decodes create / increase / decrease event layouts", () => {
    const open = decodeRaydiumLiquidityEvent(encodeCreate(pool, owner, 10n, 20n, 100n));
    expect(open).toEqual({
      kind: "open",
      poolState: pool.toBase58(),
      nftOwner: owner.toBase58(),
      tickLower: -100,
      tickUpper: 100,
      liquidity: "100",
      amountA: "10",
      amountB: "20",
    });

    const inc = decodeRaydiumLiquidityEvent(encodeIncrease(nft, 3n, 4n, 7n));
    expect(inc).toMatchObject({ kind: "increase", positionNftMint: nft.toBase58(), amountA: "3", amountB: "4" });

    const dec = decodeRaydiumLiquidityEvent(encodeDecrease(nft, 1n, 2n, 5n, 6n));
    expect(dec).toMatchObject({
      kind: "decrease",
      positionNftMint: nft.toBase58(),
      principalA: "1",
      principalB: "2",
      feeA: "5",
      feeB: "6",
    });
  });

  it("parses Program data log lines and ignores unrelated events", () => {
    const unrelated = Buffer.alloc(16);
    createHash("sha256").update("event:UpdateRewardInfosEvent").digest().subarray(0, 8).copy(unrelated);
    const logs = [
      "Program log: Instruction: OpenPosition",
      `Program data: ${encodeCreate(pool, owner, 10n, 20n, 100n).toString("base64")}`,
      `Program data: ${unrelated.toString("base64")}`,
      `Program data: ${encodeIncrease(nft, 1n, 0n, 2n).toString("base64")}`,
    ];
    const events = parseRaydiumEventsFromLogs(logs);
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("open");
    expect(events[1]?.kind).toBe("increase");
  });

  it("aggregates cashflows for the matching mint/pool only", () => {
    const events = [
      decodeRaydiumLiquidityEvent(encodeCreate(pool, owner, 100n, 200n, 1n))!,
      decodeRaydiumLiquidityEvent(encodeIncrease(nft, 10n, 0n, 1n))!,
      decodeRaydiumLiquidityEvent(encodeIncrease(otherNft, 999n, 999n, 1n))!,
      decodeRaydiumLiquidityEvent(encodeDecrease(nft, 5n, 6n, 7n, 8n))!,
    ];
    const totals = aggregateCashflowsForPosition(events, nft.toBase58(), pool.toBase58());
    expect(totals.depositedA).toBe(110n);
    expect(totals.depositedB).toBe(200n);
    expect(totals.withdrawnPrincipalA).toBe(5n);
    expect(totals.withdrawnPrincipalB).toBe(6n);
    expect(totals.feesCollectedA).toBe(7n);
    expect(totals.feesCollectedB).toBe(8n);
    expect(totals.openCount).toBe(1);
    expect(totals.increaseCount).toBe(1);
    expect(totals.decreaseCount).toBe(1);
  });
});
