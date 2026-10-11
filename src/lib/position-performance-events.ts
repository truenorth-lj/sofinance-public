/**
 * Parse Raydium CLMM Anchor events from transaction log "Program data:" lines.
 *
 * Event layouts from raydium-io/raydium-clmm PersonalPositionState module:
 * - CreatePersonalPositionEvent
 * - IncreaseLiquidityEvent
 * - DecreaseLiquidityEvent (includes fee_amount_0/1 — the only collect path)
 */

import { createHash } from "node:crypto";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { CLMM_PROGRAM_ID } from "@raydium-io/raydium-sdk-v2";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

const instructionDisc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const OPEN_TOKEN22_DISC = instructionDisc("open_position_with_token22_nft");
const OPEN_V2_DISC = instructionDisc("open_position_v2");

export type PositionEventContext = {
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
};

export function parsePositionCashflowEvents(
  logs: readonly string[] | null | undefined,
  transaction: ParsedTransactionWithMeta | undefined,
  context: PositionEventContext,
): PositionCashflowEvent[] {
  if (transaction?.meta?.err) return [];
  const events = parseRaydiumEventsFromLogs(logs).filter(event => event.kind === "open"
    ? event.poolState === context.poolId : event.positionNftMint === context.positionMint);
  if (!transaction?.meta || !logs?.includes("Log truncated") || events.some(event => event.kind === "open")) return events;

  // A zap can exhaust Solana's log budget before CreatePersonalPositionEvent.
  // The receipt still contains the opening instruction and its actual transfers.
  // Never use amountMax or whole-wallet balance deltas as deposited amounts.
  for (const [index, instruction] of transaction.transaction.message.instructions.entries()) {
    if (instruction.programId.toBase58() !== CLMM_PROGRAM_ID.toBase58() || !("accounts" in instruction)) continue;
    let data: Buffer;
    try { data = Buffer.from(bs58.decode(instruction.data)); } catch { continue; }
    if (data.length < 58) continue;
    const disc = data.subarray(0, 8);
    const token22 = disc.equals(OPEN_TOKEN22_DISC);
    const v2 = disc.equals(OPEN_V2_DISC);
    if (!token22 && !v2) continue;
    const shift = token22 ? 0 : 1; // v2 adds a metadata account before the pool.
    const account = (offset: number) => instruction.accounts[offset]?.toBase58();
    if (account(2) !== context.positionMint || account(4 + shift) !== context.poolId ||
        account(8 + shift) !== context.positionAccount || account(11 + shift) !== context.vaultA ||
        account(12 + shift) !== context.vaultB || account(token22 ? 18 : 20) !== context.mintA ||
        account(token22 ? 19 : 21) !== context.mintB) continue;
    const inner = transaction.meta.innerInstructions?.find(group => group.index === index)?.instructions;
    if (!inner) continue;
    const deposited = (source: string | undefined, destination: string, mint: string, maxOffset: number): bigint | null => {
      let total = 0n;
      let found = false;
      for (const transfer of inner) {
        if (!("parsed" in transfer) || ![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(transfer.programId.toBase58())) continue;
        const { type, info } = transfer.parsed;
        if (type !== "transferChecked" && type !== "transfer") continue;
        if (!source || info?.source !== source || info?.destination !== destination || info?.authority !== account(0)) continue;
        if (type === "transferChecked" && info.mint !== mint) return null;
        const amount = type === "transferChecked" ? info.tokenAmount?.amount : info.amount;
        if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
        total += BigInt(amount);
        found = true;
      }
      // A one-sided opening legitimately has no transfer on the zero side.
      return found || data.readBigUInt64LE(maxOffset) === 0n ? total : null;
    };
    const amountA = deposited(account(9 + shift), context.vaultA, context.mintA, 40);
    const amountB = deposited(account(10 + shift), context.vaultB, context.mintB, 48);
    if (amountA === null || amountB === null) continue;
    events.push({
      kind: "open", poolState: context.poolId, nftOwner: account(1)!,
      tickLower: data.readInt32LE(8), tickUpper: data.readInt32LE(12),
      liquidity: readU128(data, 24).toString(), amountA: amountA.toString(), amountB: amountB.toString(),
    });
  }
  return events;
}

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
