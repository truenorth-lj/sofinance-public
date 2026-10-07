/**
 * Parse Raydium CLMM Anchor events from transaction log "Program data:" lines.
 *
 * Event layouts from raydium-io/raydium-clmm PersonalPositionState module:
 * - CreatePersonalPositionEvent
 * - IncreaseLiquidityEvent
 * - DecreaseLiquidityEvent (includes fee_amount_0/1 — the only collect path)
 */

import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";

const REWARD_NUM = 3;

const eventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8);

export const CREATE_PERSONAL_POSITION_DISC = eventDisc("CreatePersonalPositionEvent");
export const INCREASE_LIQUIDITY_DISC = eventDisc("IncreaseLiquidityEvent");
export const DECREASE_LIQUIDITY_DISC = eventDisc("DecreaseLiquidityEvent");

export type PositionCashflowEvent =
  | {
      kind: "open";
      poolState: string;
      nftOwner: string;
      tickLower: number;
      tickUpper: number;
      liquidity: string;
      amountA: string;
      amountB: string;
    }
  | {
      kind: "increase";
      positionNftMint: string;
      liquidity: string;
      amountA: string;
      amountB: string;
    }
  | {
      kind: "decrease";
      positionNftMint: string;
      liquidity: string;
      principalA: string;
      principalB: string;
      feeA: string;
      feeB: string;
    };

function readU128(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset) + (buf.readBigUInt64LE(offset + 8) << 64n);
}

function readPubkey(buf: Buffer, offset: number): string {
  return new PublicKey(buf.subarray(offset, offset + 32)).toBase58();
}

/** Decode one Anchor event payload (including 8-byte discriminator). */
export function decodeRaydiumLiquidityEvent(data: Buffer): PositionCashflowEvent | null {
  if (data.length < 8) return null;
  const disc = data.subarray(0, 8);

  if (disc.equals(CREATE_PERSONAL_POSITION_DISC)) {
    // pool(32) minter(32) nft_owner(32) tick_l(i32) tick_u(i32) liq(u128)
    // deposit0(u64) deposit1(u64) fee0(u64) fee1(u64)
    if (data.length < 8 + 32 * 3 + 4 + 4 + 16 + 8 * 4) return null;
    let o = 8;
    const poolState = readPubkey(data, o); o += 32;
    o += 32; // minter
    const nftOwner = readPubkey(data, o); o += 32;
    const tickLower = data.readInt32LE(o); o += 4;
    const tickUpper = data.readInt32LE(o); o += 4;
    const liquidity = readU128(data, o).toString(); o += 16;
    const amountA = data.readBigUInt64LE(o).toString(); o += 8;
    const amountB = data.readBigUInt64LE(o).toString(); o += 8;
    return { kind: "open", poolState, nftOwner, tickLower, tickUpper, liquidity, amountA, amountB };
  }

  if (disc.equals(INCREASE_LIQUIDITY_DISC)) {
    // nft(32) liq(u128) amount0(u64) amount1(u64) fee0(u64) fee1(u64)
    if (data.length < 8 + 32 + 16 + 8 * 4) return null;
    let o = 8;
    const positionNftMint = readPubkey(data, o); o += 32;
    const liquidity = readU128(data, o).toString(); o += 16;
    const amountA = data.readBigUInt64LE(o).toString(); o += 8;
    const amountB = data.readBigUInt64LE(o).toString(); o += 8;
    return { kind: "increase", positionNftMint, liquidity, amountA, amountB };
  }

  if (disc.equals(DECREASE_LIQUIDITY_DISC)) {
    // nft(32) liq(u128) dec0(u64) dec1(u64) fee0(u64) fee1(u64)
    // rewards[REWARD_NUM](u64) transfer_fee0(u64) transfer_fee1(u64)
    if (data.length < 8 + 32 + 16 + 8 * 4 + 8 * REWARD_NUM + 8 * 2) return null;
    let o = 8;
    const positionNftMint = readPubkey(data, o); o += 32;
    const liquidity = readU128(data, o).toString(); o += 16;
    const principalA = data.readBigUInt64LE(o).toString(); o += 8;
    const principalB = data.readBigUInt64LE(o).toString(); o += 8;
    const feeA = data.readBigUInt64LE(o).toString(); o += 8;
    const feeB = data.readBigUInt64LE(o).toString(); o += 8;
    return { kind: "decrease", positionNftMint, liquidity, principalA, principalB, feeA, feeB };
  }

  return null;
}

/** Extract Raydium liquidity cashflow events from Solana log messages. */
export function parseRaydiumEventsFromLogs(logMessages: readonly string[] | null | undefined): PositionCashflowEvent[] {
  if (!logMessages?.length) return [];
  const out: PositionCashflowEvent[] = [];
  for (const line of logMessages) {
    if (!line.startsWith("Program data: ")) continue;
    let buf: Buffer;
    try {
      buf = Buffer.from(line.slice("Program data: ".length), "base64");
    } catch {
      continue;
    }
    const event = decodeRaydiumLiquidityEvent(buf);
    if (event) out.push(event);
  }
  return out;
}

export type AggregatedCashflows = {
  depositedA: bigint;
  depositedB: bigint;
  withdrawnPrincipalA: bigint;
  withdrawnPrincipalB: bigint;
  feesCollectedA: bigint;
  feesCollectedB: bigint;
  openCount: number;
  increaseCount: number;
  decreaseCount: number;
};

/** Sum deposits / withdrawals / collected fees for one position NFT mint + pool. */
export function aggregateCashflowsForPosition(
  events: readonly PositionCashflowEvent[],
  positionNftMint: string,
  poolId: string,
): AggregatedCashflows {
  const totals: AggregatedCashflows = {
    depositedA: 0n,
    depositedB: 0n,
    withdrawnPrincipalA: 0n,
    withdrawnPrincipalB: 0n,
    feesCollectedA: 0n,
    feesCollectedB: 0n,
    openCount: 0,
    increaseCount: 0,
    decreaseCount: 0,
  };

  for (const event of events) {
    if (event.kind === "open") {
      if (event.poolState !== poolId) continue;
      totals.depositedA += BigInt(event.amountA);
      totals.depositedB += BigInt(event.amountB);
      totals.openCount += 1;
      continue;
    }
    if (event.positionNftMint !== positionNftMint) continue;
    if (event.kind === "increase") {
      totals.depositedA += BigInt(event.amountA);
      totals.depositedB += BigInt(event.amountB);
      totals.increaseCount += 1;
    } else {
      totals.withdrawnPrincipalA += BigInt(event.principalA);
      totals.withdrawnPrincipalB += BigInt(event.principalB);
      totals.feesCollectedA += BigInt(event.feeA);
      totals.feesCollectedB += BigInt(event.feeB);
      totals.decreaseCount += 1;
    }
  }
  return totals;
}
