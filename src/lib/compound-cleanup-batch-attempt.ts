import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { compoundReceiptsKey, loadCompoundReceipts, parseCompoundAttempt, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { AtomicStatus } from "./attempt-status";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";

export type CleanupBatchTransaction = { summary: CompoundRecoverySummary; signature: string; status: AtomicStatus;
  chainStatus?: CompoundChainStatus; unsent?: boolean };
export type CleanupBatchAttempt = { version: 1; wallet: string; createdAt: number; receipts: CompoundReceipt[];
  alreadyClosed: string[]; transactions: CleanupBatchTransaction[] };
export const cleanupBatchKey = (wallet: string) => `sofinance:compound-cleanup-batch:v1:${wallet}`;
export const batchUnresolved = (attempt: CleanupBatchAttempt | null) => !!attempt?.transactions.some(tx =>
  !tx.unsent && !(tx.status === "success" || tx.status === "failed" || tx.status === "expired"));
export function validBatchSummary(summary: CompoundRecoverySummary, wallet: string, positionMint: string, signature: string) {
  return summary && Array.isArray(summary.compoundAccounts) && summary.compoundAccounts.length > 0 && summary.compoundAccounts.length <= 64 &&
    summary.compoundAccounts.every(account => parseCompoundAttempt({ version: 1, wallet, positionMint, signature, createdAt: 1, kind: "recovery",
      summary: { ...summary, compoundAccounts: [account] } }, wallet) !== null);
}
export function loadCleanupBatch(storage: Pick<Storage, "getItem">, wallet: string): { attempt: CleanupBatchAttempt | null; invalid: boolean } {
  const raw = storage.getItem(cleanupBatchKey(wallet));
  if (raw === null) return { attempt: null, invalid: false };
  try {
    const value = JSON.parse(raw) as CleanupBatchAttempt;
    const receipts = loadCompoundReceipts({ getItem: () => JSON.stringify(value.receipts) }, wallet);
    if (value.version !== 1 || value.wallet !== wallet || !Number.isSafeInteger(value.createdAt) || value.createdAt <= 0 ||
      receipts.invalid || !receipts.receipts.length || !Array.isArray(value.transactions) || value.transactions.length > 32 ||
      !Array.isArray(value.alreadyClosed) || value.alreadyClosed.some(x => typeof x !== "string")) throw new Error("Invalid batch record");
    const sources = new Set(receipts.receipts.flatMap(item => item.compoundAccounts.map(account => account.address)));
    const seen = new Set<string>();
    for (const address of value.alreadyClosed) { if (!sources.has(address) || seen.has(address)) throw new Error("Invalid closed source"); seen.add(address); }
    for (const tx of value.transactions) {
      if (!["pending", "success", "failed", "expired", "manual-review"].includes(tx.status) ||
        tx.chainStatus !== undefined && !["pending", "success", "failed", "expired", "unknown"].includes(tx.chainStatus) ||
        tx.unsent !== undefined && typeof tx.unsent !== "boolean" ||
        tx.status === "success" && tx.chainStatus !== "success" ||
        !validBatchSummary(tx.summary, wallet, receipts.receipts[0]!.positionMint, tx.signature)) throw new Error("Invalid transaction");
      for (const account of tx.summary.compoundAccounts) {
        if (!sources.has(account.address) || seen.has(account.address)) throw new Error("Invalid batch sources"); seen.add(account.address);
      }
    }
    if (sources.size !== seen.size || new Set(value.transactions.map(tx => tx.signature)).size !== value.transactions.length) throw new Error("Incomplete batch record");
    return { attempt: value, invalid: false };
  } catch { return { attempt: null, invalid: true }; }
}
export function persistCleanupBatch(storage: Pick<Storage, "getItem" | "setItem">, attempt: CleanupBatchAttempt) {
  const key = cleanupBatchKey(attempt.wallet), raw = JSON.stringify(attempt);
  if (loadCleanupBatch({ getItem: () => raw }, attempt.wallet).invalid) throw new Error("Invalid cleanup record; transaction not broadcast");
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Unable to save cleanup signatures; transaction not broadcast");
  return raw;
}
export function pruneCleanedReceipts(storage: Pick<Storage, "getItem" | "setItem">, attempt: CleanupBatchAttempt) {
  const saved = loadCompoundReceipts(storage, attempt.wallet);
  if (saved.invalid) throw new Error("Local yield records require verification");
  const closed = new Set([...attempt.alreadyClosed, ...attempt.transactions.filter(tx => tx.status === "success")
    .flatMap(tx => tx.summary.compoundAccounts.map(account => account.address))]);
  const receipts = saved.receipts.filter(item => !item.compoundAccounts.every(account => closed.has(account.address)));
  const raw = JSON.stringify(receipts), key = compoundReceiptsKey(attempt.wallet);
  storage.setItem(key, raw);
  if (storage.getItem(key) !== raw) throw new Error("Unable to save cleaned account records");
  return receipts;
}
export function cleanupBatchProgress(attempt: CleanupBatchAttempt) {
  const closed = new Set([...attempt.alreadyClosed, ...attempt.transactions.filter(tx => tx.status === "success")
    .flatMap(tx => tx.summary.compoundAccounts.map(account => account.address))]);
  return { completed: attempt.receipts.filter(receipt => receipt.compoundAccounts.every(account => closed.has(account.address))).length,
    total: attempt.receipts.length };
}
