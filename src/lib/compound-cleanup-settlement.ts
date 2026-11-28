import type { CleanupBatchAttempt } from "./compound-cleanup-batch-attempt";

/** Shown when the cleanup row cannot be marked done (an on-chain failure, or nothing was sent). */
export const CLEANUP_DID_NOT_COMPLETE = "The cleanup did not complete.";
/** Shown when confirm timed out (or needs review) and signed transactions may still settle. */
export const CLEANUP_STILL_CONFIRMING = "The cleanup is still confirming. Check it in Activity before trying again.";

/**
 * Whether a signed cleanup batch has settled on Solana. `pending` means at least one sent transaction is still being
 * checked. `failed` includes an on-chain failure, expiry, or a result that needs manual review — the cleanup row must
 * not be marked done; the user goes to recovery. Empty `transactions` (every account already closed) is success.
 * `unsent` transactions were never broadcast and do not count as a settlement.
 */
export function cleanupBatchSettlement(attempt: CleanupBatchAttempt): "success" | "failed" | "pending" {
  const sent = attempt.transactions.filter((tx) => !tx.unsent);
  // Empty `transactions` means every account was already closed. A mix of confirmed and `unsent` chunks is
  // not success: the unsent accounts are still open.
  if (!attempt.transactions.length) return "success";
  if (!sent.length) return "failed";
  if (sent.some((tx) => tx.status === "failed" || tx.status === "expired" || tx.status === "manual-review")) return "failed";
  if (attempt.transactions.some((tx) => tx.unsent) && sent.every((tx) => tx.status === "success")) return "failed";
  if (sent.every((tx) => tx.status === "success")) return "success";
  return "pending";
}

/**
 * A confirm that never settled, or a result that needs review: not an on-chain failure or expiry. The cleanup row
 * says Unconfirmed (no Retry cleanup). Recovery is still offered.
 */
export function cleanupOutcomeUnconfirmed(attempt: CleanupBatchAttempt): boolean {
  const sent = attempt.transactions.filter((tx) => !tx.unsent);
  if (!sent.length) return false;
  if (sent.some((tx) => tx.status === "failed" || tx.status === "expired")) return false;
  return cleanupBatchSettlement(attempt) === "pending" || sent.some((tx) => tx.status === "manual-review");
}
