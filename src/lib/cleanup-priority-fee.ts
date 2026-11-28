import { ComputeBudgetProgram, type Connection, type TransactionInstruction } from "@solana/web3.js";

/**
 * Priority fee for the cleanup batch. The cleanup is the one compound transaction the wallet only signs and our server
 * broadcasts, so unlike the wallet-sent compounds nothing else raises its priority: a base-fee-only message can be
 * dropped under load. The price follows the recent network level but is floored (so it is never zero) and capped (so
 * the total stays a few thousandths of a cent).
 */
export const CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS = 5_000;
/** Ceiling for the whole priority fee of one cleanup transaction (0.00005 SOL). */
export const CLEANUP_PRIORITY_MAX_LAMPORTS = 50_000;
export const CLEANUP_UNITS_HEADROOM = 1.3;
export const CLEANUP_UNITS_MIN = 10_000;
export const CLEANUP_UNITS_MAX = 1_400_000;
/** Per-account allowance when the probe simulation gives no usage (ATA create, transfer, close on Token-2022). */
const FALLBACK_UNITS_BASE = 50_000;
const FALLBACK_UNITS_PER_ACCOUNT = 60_000;

export type CleanupComputeBudget = { units: number; microLamports: number };

/** Same wire size as any real budget, for packing the batch before the real limit is known. */
export const CLEANUP_BUDGET_SIZE_PROBE: CleanupComputeBudget = { units: CLEANUP_UNITS_MAX, microLamports: 1 };

export function cleanupComputeUnitLimit(unitsConsumed: number | undefined, accountCount: number): number {
  const wanted = unitsConsumed !== undefined && Number.isFinite(unitsConsumed) && unitsConsumed > 0
    ? Math.ceil(unitsConsumed * CLEANUP_UNITS_HEADROOM)
    : FALLBACK_UNITS_BASE + FALLBACK_UNITS_PER_ACCOUNT * accountCount;
  return Math.min(CLEANUP_UNITS_MAX, Math.max(CLEANUP_UNITS_MIN, wanted));
}

/** Percentile of the recent per-slot fees (micro-lamports per compute unit), floored and capped for `unitLimit`. */
export function cleanupComputeUnitPrice(samples: readonly number[], unitLimit: number): number {
  const sorted = samples.filter((value) => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
  const recent = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]! : 0;
  const cap = Math.max(1, Math.floor(CLEANUP_PRIORITY_MAX_LAMPORTS * 1_000_000 / Math.max(1, unitLimit)));
  return Math.min(cap, Math.max(CLEANUP_PRIORITY_FLOOR_MICROLAMPORTS, Math.floor(recent)));
}

/** Recent per-slot prioritization fees; an unavailable RPC method just means the floor price. */
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
