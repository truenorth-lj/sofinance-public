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
const INCREASE_DISC = instructionDisc("increase_liquidity");
const INCREASE_V2_DISC = instructionDisc("increase_liquidity_v2");
const DECREASE_DISC = instructionDisc("decrease_liquidity");
const DECREASE_V2_DISC = instructionDisc("decrease_liquidity_v2");

export type PositionEventContext = {
  positionMint: string;
  positionAccount: string;
  poolId: string;
  mintA: string;
  mintB: string;
  vaultA: string;
  vaultB: string;
};

type HistoryInstruction = ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number];

function actualTransferAmount(
  instructions: readonly HistoryInstruction[],
  source: string | undefined,
  destination: string | undefined,
  mint: string,
  authority: string | undefined,
): bigint | null {
  if (!source || !destination || !authority) return null;
  let total = 0n;
  for (const instruction of instructions) {
    if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(instruction.programId.toBase58())) continue;
    if (!("parsed" in instruction)) return null;
    const { type, info } = instruction.parsed;
    if (info?.source !== source || info?.destination !== destination) continue;
    if (type !== "transferChecked" && type !== "transfer") return null;
    if (info.authority !== authority) return null;
    if (type === "transferChecked" && info.mint !== mint) return null;
    const amount = type === "transferChecked" ? info.tokenAmount?.amount : info.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    total += BigInt(amount);
  }
  return total;
}

type WithdrawalCalculation = { principalA: bigint; principalB: bigint; feeA: bigint; feeB: bigint };
const CALCULATE_DISC = createHash("sha256").update("event:LiquidityCalculateEvent").digest().subarray(0, 8);

/** Calculation events have no position ID: bind them to the invoking instruction. */
function scopedWithdrawalCalculations(logs: readonly string[], instructions: readonly HistoryInstruction[]) {
  const calculations = new Map<number, WithdrawalCalculation>();
  const stack: string[] = [];
  let nextInstruction = 0;
  let outerIndex = -1;
  for (const line of logs) {
    const invoke = /^Program (\S+) invoke \[(\d+)\]$/.exec(line);
    if (invoke) {
      if (invoke[2] === "1") {
        outerIndex = instructions.findIndex((instruction, index) => index >= nextInstruction && instruction.programId.toBase58() === invoke[1]);
        if (outerIndex >= 0) nextInstruction = outerIndex + 1;
        stack.length = 0;
      }
      stack.push(invoke[1]!);
      continue;
    }
    if (/^Program \S+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (outerIndex < 0 || stack.length !== 1 || stack[0] !== CLMM_PROGRAM_ID.toBase58() || !line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    if (data.length !== 92 || !data.subarray(0, 8).equals(CALCULATE_DISC)) continue;
    if (calculations.has(outerIndex)) incompletePositionHistory("ambiguous withdrawal calculation events");
    calculations.set(outerIndex, { principalA: data.readBigUInt64LE(44), principalB: data.readBigUInt64LE(52),
      feeA: data.readBigUInt64LE(60), feeB: data.readBigUInt64LE(68) });
  }
  return calculations;
}

function incompletePositionHistory(detail: string): never {
  throw new Error(`Position history is incomplete: ${detail}. Transaction logs were truncated; performance cannot be calculated reliably.`);
}

export function parsePositionCashflowEvents(
  logs: readonly string[] | null | undefined,
  transaction: ParsedTransactionWithMeta | undefined,
  context: PositionEventContext,
): PositionCashflowEvent[] {
  if (transaction?.meta?.err) return [];
  const events = parseRaydiumEventsFromLogs(logs).filter(event => event.kind === "open"
    ? event.poolState === context.poolId : event.positionNftMint === context.positionMint);
  if (!transaction?.meta || !logs?.includes("Log truncated")) return events;

  // Truncation leaves a prefix of emitted events. Consume those in instruction
  // order, then recover each missing operation exactly once (including compound).
  const recorded = [...events];
  const calculations = scopedWithdrawalCalculations(logs, transaction.transaction.message.instructions);
  const consume = (kind: PositionCashflowEvent["kind"]) => {
    const index = recorded.findIndex(event => event.kind === kind);
    if (index < 0) return false;
    recorded.splice(index, 1);
    return true;
  };
  for (const [index, instruction] of transaction.transaction.message.instructions.entries()) {
    if (instruction.programId.toBase58() !== CLMM_PROGRAM_ID.toBase58() || !("accounts" in instruction)) continue;
    let data: Buffer;
    try { data = Buffer.from(bs58.decode(instruction.data)); } catch { continue; }
    const disc = data.subarray(0, 8);
    const account = (offset: number) => instruction.accounts[offset]?.toBase58();
    const matches = (position: number, pool: number, vaultA: number, vaultB: number) =>
      account(position) === context.positionAccount && account(pool) === context.poolId &&
      account(vaultA) === context.vaultA && account(vaultB) === context.vaultB;
    const inner = transaction.meta.innerInstructions?.find(group => group.index === index)?.instructions;
    const token22 = disc.equals(OPEN_TOKEN22_DISC);
    const openV2 = disc.equals(OPEN_V2_DISC);
    if (token22 || openV2) {
      const shift = token22 ? 0 : 1;
      if (data.length < 58 || account(2) !== context.positionMint || !matches(8 + shift, 4 + shift, 11 + shift, 12 + shift) ||
          account(token22 ? 18 : 20) !== context.mintA || account(token22 ? 19 : 21) !== context.mintB) continue;
      if (consume("open")) continue;
      if (!inner) incompletePositionHistory("opening transfer receipts are unavailable");
      const amountA = actualTransferAmount(inner, account(9 + shift), context.vaultA, context.mintA, account(0));
      const amountB = actualTransferAmount(inner, account(10 + shift), context.vaultB, context.mintB, account(0));
      if (amountA === null || amountB === null) incompletePositionHistory("opening transfer amounts are unavailable");
      events.push({ kind: "open", poolState: context.poolId, nftOwner: account(1)!,
        tickLower: data.readInt32LE(8), tickUpper: data.readInt32LE(12),
        liquidity: readU128(data, 24).toString(), amountA: amountA.toString(), amountB: amountB.toString() });
      continue;
    }

    const increaseV2 = disc.equals(INCREASE_V2_DISC);
    if (increaseV2 || disc.equals(INCREASE_DISC)) {
      if (data.length < 40 || !matches(4, 2, 9, 10) ||
          (increaseV2 && (account(13) !== context.mintA || account(14) !== context.mintB))) continue;
      if (consume("increase")) continue;
      if (!inner) incompletePositionHistory("add-liquidity transfer receipts are unavailable");
      const amountA = actualTransferAmount(inner, account(7), context.vaultA, context.mintA, account(0));
      const amountB = actualTransferAmount(inner, account(8), context.vaultB, context.mintB, account(0));
      if (amountA === null || amountB === null) incompletePositionHistory("add-liquidity transfer amounts are unavailable");
      events.push({ kind: "increase", positionNftMint: context.positionMint,
        liquidity: readU128(data, 8).toString(), amountA: amountA.toString(), amountB: amountB.toString() });
      continue;
    }

    const decreaseV2 = disc.equals(DECREASE_V2_DISC);
    if (decreaseV2 || disc.equals(DECREASE_DISC)) {
      if (data.length < 40 || !matches(2, 3, 5, 6) ||
          (decreaseV2 && (account(14) !== context.mintA || account(15) !== context.mintB))) continue;
      if (consume("decrease")) continue;
      const liquidity = readU128(data, 8);
      // Raydium transfers principal + fees together. Without the event, a
      // positive-liquidity withdrawal cannot be split from transfers alone.
      const calculation = calculations.get(index);
      if (liquidity !== 0n && !calculation) incompletePositionHistory("withdrawal principal and fees are unavailable as separate amounts");
      // A real zero-fee collect emits the calculation but performs no CPI,
      // so the RPC legitimately records an empty inner-instruction array.
      const zeroCalculation = calculation && Object.values(calculation).every(amount => amount === 0n);
      const receipts = inner ?? (zeroCalculation && Array.isArray(transaction.meta.innerInstructions) ? [] : undefined);
      if (!receipts) incompletePositionHistory("withdrawal transfer receipts are unavailable");
      const totalA = actualTransferAmount(receipts, context.vaultA, account(9), context.mintA, context.poolId);
      const totalB = actualTransferAmount(receipts, context.vaultB, account(10), context.mintB, context.poolId);
      if (totalA === null || totalB === null) incompletePositionHistory("withdrawal transfer amounts are unavailable");
      const split = calculation ?? { principalA: 0n, principalB: 0n, feeA: totalA, feeB: totalB };
      if (split.principalA + split.feeA !== totalA || split.principalB + split.feeB !== totalB ||
          (liquidity === 0n && (split.principalA !== 0n || split.principalB !== 0n))) {
        incompletePositionHistory("withdrawal calculation does not match its actual transfers");
      }
      events.push({ kind: "decrease", positionNftMint: context.positionMint,
        liquidity: liquidity.toString(), principalA: split.principalA.toString(), principalB: split.principalB.toString(),
        feeA: split.feeA.toString(), feeB: split.feeB.toString() });
    }
  }
  // CPI layouts can contain several operations in one outer instruction. Do
  // not silently omit those when the final event has disappeared: their
  // transfer receipts cannot be isolated by the outer index alone.
  for (const group of transaction.meta.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (!instruction.programId.equals(CLMM_PROGRAM_ID) || !("accounts" in instruction)) continue;
      let disc: Buffer;
      try { disc = Buffer.from(bs58.decode(instruction.data)).subarray(0, 8); } catch { continue; }
      const account = (index: number) => instruction.accounts[index]?.toBase58();
      let kind: PositionCashflowEvent["kind"] | undefined;
      if ((disc.equals(INCREASE_DISC) || disc.equals(INCREASE_V2_DISC)) && account(4) === context.positionAccount && account(2) === context.poolId) kind = "increase";
      if ((disc.equals(DECREASE_DISC) || disc.equals(DECREASE_V2_DISC)) && account(2) === context.positionAccount && account(3) === context.poolId) kind = "decrease";
      if ((disc.equals(OPEN_TOKEN22_DISC) || disc.equals(OPEN_V2_DISC)) && account(2) === context.positionMint) kind = "open";
      if (kind && !consume(kind)) incompletePositionHistory("nested position operation is missing its cashflow event");
    }
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
