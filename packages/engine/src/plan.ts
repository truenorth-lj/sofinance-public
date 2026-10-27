// Multi-transaction plans.
//
// The single-payer engine guaranteed "one packet" for open and compound and "one or two packets"
// for withdraw. Sponsored mode adds a fee-payer signature (+64 bytes) and static key (+32 bytes),
// so callers must be ready for an ordered list of transactions. Builders keep their original
// return shapes (owner mode is byte-for-byte unchanged); these helpers adapt any result to a plan.
import { TransactionMessage, VersionedTransaction, type AddressLookupTableAccount, type PublicKey, type TransactionInstruction } from "@solana/web3.js";
import { versionedTransactionSize } from "./open-transaction";
import { SOLANA_TX_SIZE_LIMIT } from "./transaction-limits";

export type PlannedTransaction = {
  /** Stable step label, e.g. "open-position", "compound", "withdraw", "swap". */
  label: string;
  transaction: VersionedTransaction;
  /** Base58 public keys that must sign, in message order (fee payer first). */
  signers: string[];
  sizeBytes: number;
};

export type TransactionPlan = {
  /** True when the whole operation is one atomic transaction. */
  atomic: boolean;
  /** Send in order; step N+1 may depend on state created by step N. */
  steps: PlannedTransaction[];
};

export function requiredSigners(transaction: VersionedTransaction): string[] {
  const count = transaction.message.header.numRequiredSignatures;
  return transaction.message.staticAccountKeys.slice(0, count).map((key) => key.toBase58());
}

export function plannedTransaction(label: string, transaction: VersionedTransaction): PlannedTransaction {
  return { label, transaction, signers: requiredSigners(transaction), sizeBytes: versionedTransactionSize(transaction) };
}

export function singleTransactionPlan(label: string, transaction: VersionedTransaction): TransactionPlan {
  return { atomic: true, steps: [plannedTransaction(label, transaction)] };
}

/** Open and compound builders return `{ transaction }`: always one atomic step. */
export function planFromSingleResult(label: "open-position" | "compound", result: { transaction: VersionedTransaction }): TransactionPlan {
  return singleTransactionPlan(label, result.transaction);
}

/**
 * Withdraw returns base64 `unsignedTransaction` plus `summary.transactions` (1 = atomic, 2 = a later
 * "swap" stage that must be prepared after the first lands). The plan holds the step that can be
 * signed now and reports whether a follow-up stage is still required.
 */
export function planFromWithdrawResult(result: { unsignedTransaction: string; summary: { stage: string; transactions: number } }): TransactionPlan & { followUpStage: "swap" | null } {
  const transaction = VersionedTransaction.deserialize(Buffer.from(result.unsignedTransaction, "base64"));
  const label = result.summary.stage === "swap" ? "withdraw-swap" : result.summary.stage === "withdraw" ? "withdraw" : "withdraw-atomic";
  return {
    atomic: result.summary.transactions === 1,
    steps: [plannedTransaction(label, transaction)],
    followUpStage: result.summary.stage === "withdraw" && result.summary.transactions === 2 ? "swap" : null,
  };
}

export class InstructionGroupTooLargeError extends Error {
  constructor(readonly groupIndex: number, readonly bytes: number) {
    super(`Instruction group ${groupIndex} alone is ${bytes} bytes, exceeds ${SOLANA_TX_SIZE_LIMIT.toLocaleString("en-US")} byte limit`);
    this.name = "InstructionGroupTooLargeError";
  }
}

/**
 * Greedily pack ordered instruction groups into as few transactions as fit the packet limit.
 * A group is never split (keep instructions that must be atomic together in one group) and the
 * order of groups is preserved. Every transaction is compiled with the given payer and tables.
 */
export function packInstructionGroups(input: {
  payerKey: PublicKey;
  recentBlockhash: string;
  groups: TransactionInstruction[][];
  tables?: AddressLookupTableAccount[];
  labels?: (index: number) => string;
  /** Instructions repeated at the start of every transaction (e.g. compute budget). */
  prefix?: TransactionInstruction[];
}): TransactionPlan {
  const { payerKey, recentBlockhash, groups, tables = [], prefix = [] } = input;
  const compile = (instructions: TransactionInstruction[]) => new VersionedTransaction(
    new TransactionMessage({ payerKey, recentBlockhash, instructions: [...prefix, ...instructions] }).compileToV0Message(tables));
  const fits = (instructions: TransactionInstruction[]) => versionedTransactionSize(compile(instructions)) <= SOLANA_TX_SIZE_LIMIT;
  const batches: TransactionInstruction[][] = [];
  let current: TransactionInstruction[] = [];
  groups.forEach((group, index) => {
    if (!group.length) return;
    if (fits([...current, ...group])) { current = [...current, ...group]; return; }
    if (!fits(group)) throw new InstructionGroupTooLargeError(index, versionedTransactionSize(compile(group)));
    if (current.length) batches.push(current);
    current = [...group];
  });
  if (current.length) batches.push(current);
  const steps = batches.map((batch, index) => plannedTransaction(input.labels?.(index) ?? `step-${index + 1}`, compile(batch)));
  return { atomic: steps.length === 1, steps };
}
