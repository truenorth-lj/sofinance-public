import { ComputeBudgetProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { computeBudgetPriorityLamports } from "./wallet-priority-fee";

/**
 * Priority fee for harvest-account close transactions (the compound-all cleanup batch and the recovery-page close).
 * The wallet often only signs these and our server (or a sign-only relay) broadcasts, so unlike a wallet-sent
 * compound nothing else raises the priority: a base-fee-only message can be dropped under load. The price follows
 * the recent network level but is floored (never zero) and capped (a few thousandths of a cent).
 */
export const CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS = 5_000;
/** Ceiling for the whole priority fee of one harvest-close transaction (0.00005 SOL). */
export const CLEANUP_PRIORITY_MAX_LAMPORTS = 50_000;
export const CLEANUP_UNITS_HEADROOM = 1.3;
export const CLEANUP_UNITS_MIN = 10_000;
export const CLEANUP_UNITS_MAX = 1_400_000;
/** Typical Solana signature base fee. Used to detect an estimate that omitted the message's own priority. */
export const SIGNATURE_BASE_FEE_LAMPORTS = 5_000;
const FALLBACK_UNITS_BASE = 50_000;
const FALLBACK_UNITS_PER_ACCOUNT = 60_000;

export type CleanupComputeBudget = { units: number; microLamports: number };

/** Same wire size as any real budget, for packing before the real limit is known. */
export const CLEANUP_BUDGET_SIZE_PROBE: CleanupComputeBudget = { units: CLEANUP_UNITS_MAX, microLamports: 1 };

export function cleanupComputeUnitLimit(unitsConsumed: number | undefined, accountCount: number): number {
  const wanted = unitsConsumed !== undefined && Number.isFinite(unitsConsumed) && unitsConsumed > 0
    ? Math.ceil(unitsConsumed * CLEANUP_UNITS_HEADROOM)
    : FALLBACK_UNITS_BASE + FALLBACK_UNITS_PER_ACCOUNT * accountCount;
  return Math.min(CLEANUP_UNITS_MAX, Math.max(CLEANUP_UNITS_MIN, wanted));
}

export function cleanupComputeUnitPrice(samples: readonly number[], unitLimit: number): number {
  const sorted = samples.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const recent = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]! : 0;
  const cap = Math.max(1, Math.floor(CLEANUP_PRIORITY_MAX_LAMPORTS * 1_000_000 / Math.max(1, unitLimit)));
  return Math.min(cap, Math.max(CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS, Math.floor(recent)));
}

export async function recentPrioritizationSamples(connection: Pick<Connection, "getRecentPrioritizationFees">): Promise<number[]> {
  try {
    if (typeof connection.getRecentPrioritizationFees !== "function") return [];
    return (await connection.getRecentPrioritizationFees()).map((entry) => entry.prioritizationFee);
  } catch { return []; }
}

export function cleanupBudgetInstructions(budget: CleanupComputeBudget): TransactionInstruction[] {
  return [ComputeBudgetProgram.setComputeUnitLimit({ units: budget.units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: budget.microLamports })];
}

/** Signature-less simulation of the bare (no budget) message, used only to size the compute-unit limit. */
export async function probeComputeUnits(
  connection: Pick<Connection, "simulateTransaction">, transaction: VersionedTransaction,
): Promise<number | undefined> {
  try {
    const result = await connection.simulateTransaction(transaction, { sigVerify: false, commitment: "confirmed" });
    return result.value.err ? undefined : result.value.unitsConsumed;
  } catch { return undefined; }
}

export async function harvestPriorityBudget(
  connection: Pick<Connection, "simulateTransaction" | "getRecentPrioritizationFees">,
  bare: VersionedTransaction, accountCount: number, priceSamples?: number[],
): Promise<CleanupComputeBudget> {
  const samples = priceSamples ?? await recentPrioritizationSamples(connection as Pick<Connection, "getRecentPrioritizationFees">);
  const units = cleanupComputeUnitLimit(await probeComputeUnits(connection, bare), accountCount);
  return { units, microLamports: cleanupComputeUnitPrice(samples, units) };
}

/**
 * If `getFeeForMessage` returned only the signature base fee, add the message's own ComputeBudget priority so
 * `feeLamports` matches what simulation will debit. If the estimate already includes it (e.g. 5,000 + 650 = 5,650),
 * leave it alone — never double-count.
 */
export function feeIncludingComputeBudget(estimated: number, transaction: VersionedTransaction): number {
  const priority = Number(computeBudgetPriorityLamports(transaction));
  if (!Number.isSafeInteger(estimated) || estimated < 0 || priority <= 0) return estimated;
  if (estimated >= SIGNATURE_BASE_FEE_LAMPORTS + priority) return estimated;
  return estimated + priority;
}

/**
 * Lamports of the message's own priority that `feeLamports` did not cover. Used as simulation slack so a base-only
 * estimate cannot make prepare fail with "wallet rent or fee mismatch". Zero when the estimate already includes it.
 */
export function uncoveredComputeBudgetLamports(feeLamports: number, transaction: VersionedTransaction): bigint {
  const priority = computeBudgetPriorityLamports(transaction);
  if (priority <= 0n || !Number.isSafeInteger(feeLamports) || feeLamports < 0) return 0n;
  return BigInt(feeLamports) >= BigInt(SIGNATURE_BASE_FEE_LAMPORTS) + priority ? 0n : priority;
}

/** A copy of `transaction` whose SetComputeUnitPrice is 0, for comparing a full estimate to a base-only one. */
export function withZeroComputeUnitPrice(transaction: VersionedTransaction): VersionedTransaction {
  const compiled = TransactionMessage.decompile(transaction.message);
  const instructions = compiled.instructions.map((ix) =>
    ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3
      ? ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }) : ix);
  return new VersionedTransaction(new TransactionMessage({
    payerKey: compiled.payerKey, recentBlockhash: compiled.recentBlockhash, instructions,
  }).compileToV0Message());
}
