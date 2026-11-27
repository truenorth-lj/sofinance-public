import type { CleanupBatchAttempt } from "./compound-cleanup-batch-attempt";

/** Shown when the cleanup row cannot be marked done (an on-chain failure, a timeout, or nothing was sent). */
export const CLEANUP_DID_NOT_COMPLETE = "The cleanup did not complete.";

/**
 * Whether a signed cleanup batch has settled on Solana. `pending` means at least one sent transaction is still being
 * checked. `failed` includes an on-chain failure, expiry, or a result that needs manual review — the cleanup row must
 * not be marked done; the user goes to recovery. Empty `transactions` (every account already closed) is success.
 * `unsent` transactions were never broadcast and do not count as a settlement.
 */
export function cleanupBatchSettlement(attempt: CleanupBatchAttempt): "success" | "failed" | "pending" {
  const sent = attempt.transactions.filter((tx) => !tx.unsent);
  if (!sent.length) return attempt.transactions.length === 0 ? "success" : "failed";
  if (sent.some((tx) => tx.status === "failed" || tx.status === "expired" || tx.status === "manual-review")) return "failed";
  if (sent.every((tx) => tx.status === "success")) return "success";
  return "pending";
}
