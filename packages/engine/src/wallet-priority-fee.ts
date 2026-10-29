import { ComputeBudgetProgram, VersionedTransaction } from "@solana/web3.js";

/**
 * Wallet-raised ComputeBudget priority fees are user-chosen network fees (Phantom
 * shows them on the confirm screen). Cap them separately so a rewritten CU price
 * cannot drain unbounded SOL, without counting them against the app spend budget
 * (rent, ATA creation, our transfers / fee ix).
 */
export const WALLET_PRIORITY_FEE_CEILING_LAMPORTS = 10_000_000n;

const COMPUTE_BUDGET = ComputeBudgetProgram.programId;
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;
const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000n;

function resolveStatic(transaction: VersionedTransaction, index: number) {
  return transaction.message.staticAccountKeys[index] ?? null;
}

function readU32(data: Uint8Array, offset: number) {
  return BigInt(data[offset]!) + (BigInt(data[offset + 1]!) << 8n) + (BigInt(data[offset + 2]!) << 16n)
    + (BigInt(data[offset + 3]!) << 24n);
}

function readU64(data: Uint8Array, offset: number) {
  let value = 0n;
  for (let index = 0; index < 8; index += 1) value += BigInt(data[offset + index]!) << BigInt(8 * index);
  return value;
}

/** Priority fee implied by this message's ComputeBudget ixs (0 if no CU price). */
export function computeBudgetPriorityLamports(transaction: VersionedTransaction): bigint {
  let units: bigint | null = null;
  let microLamports: bigint | null = null;
  for (const ix of transaction.message.compiledInstructions) {
    const program = resolveStatic(transaction, ix.programIdIndex);
    if (!program?.equals(COMPUTE_BUDGET)) continue;
    const data = ix.data instanceof Uint8Array ? ix.data : Uint8Array.from(ix.data);
    if (data[0] === SET_COMPUTE_UNIT_LIMIT && data.length >= 5) units = readU32(data, 1);
    if (data[0] === SET_COMPUTE_UNIT_PRICE && data.length >= 9) microLamports = readU64(data, 1);
  }
  if (!microLamports) return 0n;
  return ((units ?? DEFAULT_COMPUTE_UNIT_LIMIT) * microLamports + 999_999n) / 1_000_000n;
}

/**
 * Extra priority fee the wallet added vs the prepared message.
 * Throws if that extra exceeds {@link WALLET_PRIORITY_FEE_CEILING_LAMPORTS}.
 */
export function walletPriorityFeeAllowance(
  prepared: VersionedTransaction | undefined,
  signed: VersionedTransaction,
): bigint {
  if (!prepared) return 0n;
  const extra = computeBudgetPriorityLamports(signed) - computeBudgetPriorityLamports(prepared);
  if (extra <= 0n) return 0n;
  if (extra > WALLET_PRIORITY_FEE_CEILING_LAMPORTS) {
    throw new Error("Wallet priority fee exceeds 0.01 SOL");
  }
  return extra;
}
