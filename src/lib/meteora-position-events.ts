/**
 * Meteora DLMM position receipts → the shared `PositionCashflowEvent` ledger
 * (same shape as Raydium / Orca, so aggregation and performance math are reused).
 *
 * The DLMM program reports each operation as an Anchor self-CPI event: an inner
 * instruction to the DLMM program, signed by its event authority PDA, whose data
 * is EVENT_IX_TAG + event discriminator + fields (inner instructions are never
 * truncated, unlike logs). Each event that names this position is cross-checked
 * against the token transfers into / out of the pool reserves in the same
 * instruction group; any mismatch is rejected rather than guessed.
 *
 * DLMM separates principal and fees: `remove_liquidity*` returns principal only
 * and `claim_fee*` returns fees only, so a claim becomes a zero-liquidity
 * `decrease` with fee amounts. DLMM events carry token amounts but not bin
 * shares, so ledger `liquidity` is "0" (informational only; aggregation uses
 * amounts). Rebalancing is not supported yet. Rewards are ignored.
 * Read-only: nothing here builds or signs a transaction.
 */

import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import bs58 from "bs58";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { METEORA_DLMM_PROGRAM_ID } from "@sofinance/engine/protocols/meteora/constants";
import type { PositionCashflowEvent, PositionEventContext } from "./position-performance-events";

type HistoryInstruction = ParsedTransactionWithMeta["transaction"]["message"]["instructions"][number];

/** Anchor `emit_cpi!` instruction tag (sha256("anchor:event")[..8]). */
export const METEORA_EVENT_IX_TAG = "e445a52e51cb9a1d";
export const METEORA_EVENT = Object.freeze({
  addLiquidity: "1f5e7d5ae3343dba",
  removeLiquidity: "74f461e8671f983a",
  claimFee: "4b7a9a308c4a7ba3",
  claimFee2: "e8abf2613a4d232d",
  positionCreate: "908efc549d352579",
  rebalancing: "006d75b33d5bc7c8",
});
export const METEORA_EVENT_AUTHORITY = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")], new PublicKey(METEORA_DLMM_PROGRAM_ID))[0].toBase58();

/** Context plus the position's bins, reported as the open's ticks (bins [lower, upper] = ticks [lower, upper + 1)). */
export type MeteoraEventContext = PositionEventContext & { lowerBinId: number; upperBinId: number };

type DecodedEvent =
  | { kind: "add" | "remove"; lbPair: string; position: string; amountX: bigint; amountY: bigint }
  | { kind: "claim"; lbPair: string; position: string; amountX: bigint; amountY: bigint }
  | { kind: "create"; lbPair: string; position: string; owner: string }
  | { kind: "rebalance"; lbPair: string; position: string };

function unsupported(detail: string): never {
  throw new Error(`Meteora position history is incomplete: ${detail}. Performance cannot be calculated reliably.`);
}

const key = (data: Buffer, offset: number) => new PublicKey(data.subarray(offset, offset + 32)).toBase58();

/** Decode one self-CPI event instruction (null for other instructions or events this ledger ignores). */
function decodeEvent(instruction: HistoryInstruction): DecodedEvent | null {
  if (instruction.programId.toBase58() !== METEORA_DLMM_PROGRAM_ID || !("data" in instruction) || typeof instruction.data !== "string") return null;
  let data: Buffer;
  try {
    data = Buffer.from(bs58.decode(instruction.data));
  } catch {
    return null;
  }
  if (data.length < 16 || data.subarray(0, 8).toString("hex") !== METEORA_EVENT_IX_TAG) return null;
  // Only the program itself can sign with its event authority; anything else is not a DLMM event.
  if (instruction.accounts[0]?.toBase58() !== METEORA_EVENT_AUTHORITY) return null;
  const body = data.subarray(16);
  const need = (length: number) => { if (body.length < length) unsupported("event data is truncated"); };
  switch (data.subarray(8, 16).toString("hex")) {
    case METEORA_EVENT.addLiquidity:
    case METEORA_EVENT.removeLiquidity:
      // lb_pair | from | position | amounts [u64; 2] | active_bin_id
      need(116);
      return { kind: data.subarray(8, 16).toString("hex") === METEORA_EVENT.addLiquidity ? "add" : "remove",
        lbPair: key(body, 0), position: key(body, 64), amountX: body.readBigUInt64LE(96), amountY: body.readBigUInt64LE(104) };
    case METEORA_EVENT.claimFee:
    case METEORA_EVENT.claimFee2:
      // lb_pair | position | owner | fee_x | fee_y [| active_bin_id]
      need(112);
      return { kind: "claim", lbPair: key(body, 0), position: key(body, 32), amountX: body.readBigUInt64LE(96), amountY: body.readBigUInt64LE(104) };
    case METEORA_EVENT.positionCreate:
      need(96);
      return { kind: "create", lbPair: key(body, 0), position: key(body, 32), owner: key(body, 64) };
    case METEORA_EVENT.rebalancing:
      need(64);
      return { kind: "rebalance", lbPair: key(body, 0), position: key(body, 32) };
    default:
      return null;
  }
}

/** Sum of token transfers into (`to`) or out of (`from`, signed by the pool) a reserve, or null when a receipt is malformed. */
function reserveFlow(instructions: readonly HistoryInstruction[], reserve: string, mint: string, poolId: string, direction: "in" | "out"): bigint | null {
  let total = 0n;
  for (const instruction of instructions) {
    if (![TOKEN_PROGRAM_ID.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58()].includes(instruction.programId.toBase58())) continue;
    if (!("parsed" in instruction)) return null;
    const { type, info } = instruction.parsed;
    if ((direction === "in" ? info?.destination : info?.source) !== reserve) continue;
    if (type !== "transferChecked" && type !== "transfer") return null;
    if (direction === "out" && info.authority !== poolId) return null;
    if (type === "transferChecked" && info.mint !== mint) return null;
    const amount = type === "transferChecked" ? info.tokenAmount?.amount : info.amount;
    if (typeof amount !== "string" || !/^\d+$/.test(amount)) return null;
    total += BigInt(amount);
  }
  return total;
}

/**
 * Parse one landed transaction for a Meteora position. Failed transactions
 * yield no events. Throws when the receipt names this position in a way the
 * ledger cannot represent exactly (rebalancing, several liquidity operations in
 * one instruction, another pool, or transfers that do not match the event).
 */
export function parseMeteoraPositionCashflowEvents(
  transaction: ParsedTransactionWithMeta | undefined,
  context: MeteoraEventContext,
): PositionCashflowEvent[] {
  if (!transaction?.meta || transaction.meta.err) return [];
  const groups = transaction.meta.innerInstructions;
  if (!Array.isArray(groups)) {
    const names = transaction.transaction.message.instructions.some((instruction) =>
      instruction.programId.toBase58() === METEORA_DLMM_PROGRAM_ID && "accounts" in instruction &&
      instruction.accounts.some((account) => account.toBase58() === context.positionAccount));
    if (names) unsupported("inner instructions are unavailable");
    return [];
  }
  const events: PositionCashflowEvent[] = [];
  let openIndex = -1;
  for (const group of [...groups].sort((a, b) => a.index - b.index)) {
    const decoded = group.instructions.map(decodeEvent).filter((event): event is DecodedEvent => event !== null);
    const ours = decoded.filter((event) => event.position === context.positionAccount);
    if (!ours.length) continue;
    if (ours.some((event) => event.lbPair !== context.poolId)) unsupported("an event names this position in another pool");
    if (ours.some((event) => event.kind === "rebalance")) unsupported("rebalancing is not supported yet");
    const cash = decoded.filter((event) => event.kind === "add" || event.kind === "remove" || event.kind === "claim");
    if (cash.length > 1) unsupported("several liquidity operations in one instruction cannot be separated");

    const create = ours.find((event) => event.kind === "create");
    if (create?.kind === "create") {
      openIndex = events.length;
      events.push({ kind: "open", poolState: context.poolId, nftOwner: create.owner,
        tickLower: context.lowerBinId, tickUpper: context.upperBinId + 1, liquidity: "0", amountA: "0", amountB: "0" });
    }
    const flow = cash[0];
    if (!flow || flow.position !== context.positionAccount) continue;
    if (flow.kind !== "add" && flow.kind !== "remove" && flow.kind !== "claim") continue;
    const into = flow.kind === "add" ? "in" : "out";
    const against = into === "in" ? "out" : "in";
    const x = reserveFlow(group.instructions, context.vaultA, context.mintA, context.poolId, into);
    const y = reserveFlow(group.instructions, context.vaultB, context.mintB, context.poolId, into);
    const backX = reserveFlow(group.instructions, context.vaultA, context.mintA, context.poolId, against);
    const backY = reserveFlow(group.instructions, context.vaultB, context.mintB, context.poolId, against);
    if (x === null || y === null || backX === null || backY === null) unsupported("transfer receipts are unavailable");
    if (x !== flow.amountX || y !== flow.amountY || backX !== 0n || backY !== 0n) unsupported("event amounts do not match the reserve transfers");

    if (flow.kind === "add") {
      const opened = openIndex >= 0 ? events[openIndex] : undefined;
      if (opened?.kind === "open" && opened.amountA === "0" && opened.amountB === "0") {
        // Position creation deposits nothing; fold the same-transaction first add into it.
        events[openIndex] = { ...opened, amountA: x.toString(), amountB: y.toString() };
      } else {
        events.push({ kind: "increase", positionNftMint: context.positionMint, liquidity: "0", amountA: x.toString(), amountB: y.toString() });
      }
    } else if (flow.kind === "remove") {
      events.push({ kind: "decrease", positionNftMint: context.positionMint, liquidity: "0",
        principalA: x.toString(), principalB: y.toString(), feeA: "0", feeB: "0" });
    } else {
      events.push({ kind: "decrease", positionNftMint: context.positionMint, liquidity: "0",
        principalA: "0", principalB: "0", feeA: x.toString(), feeB: y.toString() });
    }
  }
  return events;
}
