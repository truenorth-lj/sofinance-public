/**
 * Orca Whirlpool position receipts → the shared `PositionCashflowEvent` ledger
 * (same shape as Raydium's, so aggregation and performance math are reused).
 *
 * Amounts come from the token transfer receipts of each outer Orca
 * instruction that names this position, its whirlpool and both vaults
 * (inner instructions are never truncated, unlike logs). Orca separates
 * principal and fees: `decrease_liquidity*` returns principal only and
 * `collect_fees*` returns fees only, so a collect becomes a zero-liquidity
 * `decrease` with fee amounts. Liquidity for `increase_liquidity_by_token_amounts_v2`
 * comes from the program's `LiquidityIncreased` event; when that event is
 * missing the receipt is rejected rather than guessed. Rewards are ignored.
 * Read-only: nothing here builds or signs a transaction.
 */

import { createHash } from "node:crypto";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { ORCA_WHIRLPOOL_PROGRAM_ID } from "@sofinance/engine/protocols/orca/constants";
import type { PositionCashflowEvent, PositionEventContext } from "./position-performance-events";

type HistoryInstruction = ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number];

const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8).toString("hex");
const eventDisc = (name: string) => createHash("sha256").update(`event:${name}`).digest().subarray(0, 8).toString("hex");

export const ORCA_INSTRUCTION = Object.freeze({
  openPosition: disc("open_position"),
  openPositionWithMetadata: disc("open_position_with_metadata"),
  openPositionWithTokenExtensions: disc("open_position_with_token_extensions"),
  increaseLiquidity: disc("increase_liquidity"),
  increaseLiquidityV2: disc("increase_liquidity_v2"),
  increaseLiquidityByTokenAmountsV2: disc("increase_liquidity_by_token_amounts_v2"),
  decreaseLiquidity: disc("decrease_liquidity"),
  decreaseLiquidityV2: disc("decrease_liquidity_v2"),
  collectFees: disc("collect_fees"),
  collectFeesV2: disc("collect_fees_v2"),
  repositionLiquidityV2: disc("reposition_liquidity_v2"),
});
const LIQUIDITY_INCREASED = eventDisc("LiquidityIncreased");
const LIQUIDITY_DECREASED = eventDisc("LiquidityDecreased");

/** Account indexes per instruction layout (from the Whirlpool IDL). */
const OPEN_LAYOUT: Record<string, { whirlpool: number; ticks: number }> = {
  [ORCA_INSTRUCTION.openPosition]: { whirlpool: 5, ticks: 9 },
  [ORCA_INSTRUCTION.openPositionWithMetadata]: { whirlpool: 6, ticks: 10 },
  [ORCA_INSTRUCTION.openPositionWithTokenExtensions]: { whirlpool: 5, ticks: 8 },
};
type FlowLayout = { authority: number; position: number; ownerA: number; ownerB: number; vaultA: number; vaultB: number; mintA?: number; mintB?: number };
const V1_LIQUIDITY: FlowLayout = { authority: 2, position: 3, ownerA: 5, ownerB: 6, vaultA: 7, vaultB: 8 };
const V2_LIQUIDITY: FlowLayout = { authority: 4, position: 5, mintA: 7, mintB: 8, ownerA: 9, ownerB: 10, vaultA: 11, vaultB: 12 };
const FLOW_LAYOUT: Record<string, { kind: "increase" | "decrease" | "collect"; layout: FlowLayout; liquidityInData: boolean }> = {
  [ORCA_INSTRUCTION.increaseLiquidity]: { kind: "increase", layout: V1_LIQUIDITY, liquidityInData: true },
  [ORCA_INSTRUCTION.increaseLiquidityV2]: { kind: "increase", layout: V2_LIQUIDITY, liquidityInData: true },
  [ORCA_INSTRUCTION.increaseLiquidityByTokenAmountsV2]: { kind: "increase", layout: V2_LIQUIDITY, liquidityInData: false },
  [ORCA_INSTRUCTION.decreaseLiquidity]: { kind: "decrease", layout: V1_LIQUIDITY, liquidityInData: true },
  [ORCA_INSTRUCTION.decreaseLiquidityV2]: { kind: "decrease", layout: V2_LIQUIDITY, liquidityInData: true },
  [ORCA_INSTRUCTION.collectFees]: { kind: "collect", layout: { authority: 1, position: 2, ownerA: 4, vaultA: 5, ownerB: 6, vaultB: 7 }, liquidityInData: false },
  [ORCA_INSTRUCTION.collectFeesV2]: { kind: "collect", layout: { authority: 1, position: 2, mintA: 4, mintB: 5, ownerA: 6, vaultA: 7, ownerB: 8, vaultB: 9 }, liquidityInData: false },
};
/** Position account index for operations whose cashflows this parser does not model. */
const UNSUPPORTED_POSITION_INDEX: Record<string, number> = { [ORCA_INSTRUCTION.repositionLiquidityV2]: 6 };

function unsupported(detail: string): never {
  throw new Error(`Orca position history is incomplete: ${detail}. Performance cannot be calculated reliably.`);
}

function u128(data: Buffer, offset: number) {
  return data.readBigUInt64LE(offset) + (data.readBigUInt64LE(offset + 8) << 64n);
}

function instructionDisc(instruction: HistoryInstruction): { disc: string; data: Buffer } | null {
  if (!("data" in instruction) || typeof instruction.data !== "string") return null;
  try {
    const data = Buffer.from(bs58.decode(instruction.data));
    return data.length >= 8 ? { disc: data.subarray(0, 8).toString("hex"), data } : null;
  } catch {
    return null;
  }
}

/** Sum of SPL / Token-2022 transfers source → destination, or null when a matching receipt is malformed. */
function transferred(instructions: readonly HistoryInstruction[], source: string | undefined, destination: string | undefined,
  mint: string, authority: string | undefined): bigint | null {
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

type LiquidityEvent = { kind: "increase" | "decrease"; liquidity: bigint; amountA: bigint; amountB: bigint };

/** `LiquidityIncreased` / `LiquidityDecreased` events for this position, in log order. */
function liquidityEvents(logs: readonly string[] | null | undefined, context: PositionEventContext): LiquidityEvent[] {
  const out: LiquidityEvent[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    // disc 8 | whirlpool 32 | position 32 | tick_lower 4 | tick_upper 4 | liquidity 16 | a 8 | b 8 | fee_a 8 | fee_b 8
    if (data.length < 128) continue;
    const kind = data.subarray(0, 8).toString("hex");
    if (kind !== LIQUIDITY_INCREASED && kind !== LIQUIDITY_DECREASED) continue;
    if (new PublicKey(data.subarray(8, 40)).toBase58() !== context.poolId) continue;
    if (new PublicKey(data.subarray(40, 72)).toBase58() !== context.positionAccount) continue;
    out.push({ kind: kind === LIQUIDITY_INCREASED ? "increase" : "decrease", liquidity: u128(data, 80),
      amountA: data.readBigUInt64LE(96), amountB: data.readBigUInt64LE(104) });
  }
  return out;
}

/**
 * Parse one landed transaction for an Orca position. Failed transactions
 * yield no events. Throws when the receipt names this position in a way the
 * ledger cannot represent exactly (CPI'd operations, repositioning, missing
 * receipts or liquidity).
 */
export function parseOrcaPositionCashflowEvents(
  logs: readonly string[] | null | undefined,
  transaction: ParsedTransactionWithMeta | undefined,
  context: PositionEventContext,
): PositionCashflowEvent[] {
  if (!transaction?.meta || transaction.meta.err) return [];
  const program = ORCA_WHIRLPOOL_PROGRAM_ID;
  const instructions = transaction.transaction.message.instructions;
  const events: PositionCashflowEvent[] = [];
  const logged = liquidityEvents(logs, context);
  const loggedOf = (kind: LiquidityEvent["kind"]) => logged.filter((event) => event.kind === kind);
  const seen = { increase: 0, decrease: 0 };
  let openIndex = -1;

  for (const [index, instruction] of instructions.entries()) {
    if (instruction.programId.toBase58() !== program || !("accounts" in instruction)) continue;
    const decoded = instructionDisc(instruction);
    if (!decoded) continue;
    const account = (offset: number) => instruction.accounts[offset]?.toBase58();
    const inner = transaction.meta.innerInstructions?.find((group) => group.index === index)?.instructions;

    const open = OPEN_LAYOUT[decoded.disc];
    if (open) {
      if (account(3) !== context.positionMint) continue;
      if (account(2) !== context.positionAccount || account(open.whirlpool) !== context.poolId) unsupported("opening accounts do not match this position");
      if (decoded.data.length < open.ticks + 8) unsupported("opening instruction data is truncated");
      openIndex = events.length;
      events.push({ kind: "open", poolState: context.poolId, nftOwner: account(1)!,
        tickLower: decoded.data.readInt32LE(open.ticks), tickUpper: decoded.data.readInt32LE(open.ticks + 4),
        liquidity: "0", amountA: "0", amountB: "0" });
      continue;
    }

    const unsupportedIndex = UNSUPPORTED_POSITION_INDEX[decoded.disc];
    if (unsupportedIndex !== undefined && account(unsupportedIndex) === context.positionAccount) unsupported("repositioning is not supported yet");

    const flow = FLOW_LAYOUT[decoded.disc];
    if (!flow || account(flow.layout.position) !== context.positionAccount) continue;
    const { layout } = flow;
    if (account(0) !== context.poolId || account(layout.vaultA) !== context.vaultA || account(layout.vaultB) !== context.vaultB ||
        (layout.mintA !== undefined && (account(layout.mintA) !== context.mintA || account(layout.mintB!) !== context.mintB))) {
      unsupported("instruction accounts do not match this position's whirlpool");
    }
    // A zero-amount operation performs no CPI; the RPC then records no group.
    const receipts = inner ?? (Array.isArray(transaction.meta.innerInstructions) ? [] : undefined);
    if (!receipts) unsupported("transfer receipts are unavailable");
    const deposit = flow.kind === "increase";
    const amountA = deposit ? transferred(receipts, account(layout.ownerA), context.vaultA, context.mintA, account(layout.authority))
      : transferred(receipts, context.vaultA, account(layout.ownerA), context.mintA, context.poolId);
    const amountB = deposit ? transferred(receipts, account(layout.ownerB), context.vaultB, context.mintB, account(layout.authority))
      : transferred(receipts, context.vaultB, account(layout.ownerB), context.mintB, context.poolId);
    if (amountA === null || amountB === null) unsupported("transfer amounts are unavailable");

    if (flow.kind === "collect") {
      events.push({ kind: "decrease", positionNftMint: context.positionMint, liquidity: "0",
        principalA: "0", principalB: "0", feeA: amountA.toString(), feeB: amountB.toString() });
      continue;
    }
    const event = loggedOf(flow.kind)[seen[flow.kind]++];
    if (event && (event.amountA !== amountA || event.amountB !== amountB)) unsupported("liquidity event does not match its transfers");
    if (!flow.liquidityInData && !event) unsupported("added liquidity is unavailable without the LiquidityIncreased event");
    if (decoded.data.length < (flow.liquidityInData ? 24 : 8)) unsupported("instruction data is truncated");
    const liquidity = flow.liquidityInData ? u128(decoded.data, 8) : event!.liquidity;
    if (event && event.liquidity !== liquidity) unsupported("liquidity event does not match its instruction");

    if (flow.kind === "increase") {
      const opened = openIndex >= 0 ? events[openIndex] : undefined;
      if (opened?.kind === "open" && opened.liquidity === "0") {
        // The open instruction deposits nothing; fold the same-transaction first add into it.
        events[openIndex] = { ...opened, liquidity: liquidity.toString(), amountA: amountA.toString(), amountB: amountB.toString() };
      } else {
        events.push({ kind: "increase", positionNftMint: context.positionMint, liquidity: liquidity.toString(),
          amountA: amountA.toString(), amountB: amountB.toString() });
      }
    } else {
      events.push({ kind: "decrease", positionNftMint: context.positionMint, liquidity: liquidity.toString(),
        principalA: amountA.toString(), principalB: amountB.toString(), feeA: "0", feeB: "0" });
    }
  }

  // Operations invoked through another program cannot be isolated by outer index.
  for (const group of transaction.meta.innerInstructions ?? []) {
    for (const instruction of group.instructions) {
      if (instruction.programId.toBase58() !== program || !("accounts" in instruction)) continue;
      const decoded = instructionDisc(instruction);
      if (!decoded) continue;
      const position = FLOW_LAYOUT[decoded.disc]?.layout.position ?? UNSUPPORTED_POSITION_INDEX[decoded.disc] ?? (OPEN_LAYOUT[decoded.disc] ? 2 : undefined);
      if (position !== undefined && instruction.accounts[position]?.toBase58() === context.positionAccount) {
        unsupported("position operations invoked through another program are not supported yet");
      }
    }
  }
  return events;
}
