import type { CleanupStatus, CompoundAllRow, RowStatus } from "@/lib/compound-all/state";

/** Compound all's words, in one place (copy rules: no performance or fee claims). */
export const COMPOUND_ALL_COPY = {
  title: "Compound all",
  intro: "Adds each selected position's fees back into its range, one position at a time. Your wallet asks you to approve each one.",
  unlisted: "Positions with no unclaimed fees (or fees that could not be read) are not listed.",
  outOfRange: "Out of range: only one token's fees can go back into the position; the rest go to your wallet. Unchecked by default.",
  cleanupRow: "Clean up harvest accounts",
  cleanupDetail: "One approval at the end closes the Raydium harvest accounts this run created and returns their balances and rent.",
  recovery: "Recovery page",
  recoveryDetail: "Harvest accounts from this run that were not cleaned up can be returned on the recovery page.",
  checkpoint: (done: number) => `${done} positions done. Continue with the next ones?`,
  stopAfterThis: "Stop after this one",
} as const;

export function approvalsLine(approvals: { rows: number; cleanup: number; total: number }) {
  const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const parts = [noun(approvals.rows, "compound", "compounds"), ...(approvals.cleanup ? [noun(approvals.cleanup, "cleanup", "cleanups")] : [])];
  return { headline: `${noun(approvals.total, "wallet approval", "wallet approvals")}`, detail: parts.join(" + ") };
}

const ROW_STATUS: Record<RowStatus, string> = {
  queued: "Waiting", preparing: "Preparing…", "awaiting-wallet": "Approve in your wallet", confirming: "Confirming…",
  done: "Done", skipped: "Skipped", "not-signed": "Not signed", rejected: "Rejected in wallet", expired: "Expired", failed: "Failed",
};
export const rowStatusLabel = (row: Pick<CompoundAllRow, "status" | "selected">) => row.selected ? ROW_STATUS[row.status] : "Not selected";

const CLEANUP_STATUS: Record<CleanupStatus, string> = {
  none: "Waiting", pending: "Waiting", offered: "Ready", preparing: "Preparing…", "awaiting-wallet": "Approve in your wallet",
  confirming: "Sending…", done: "Sent", failed: "Failed", skipped: "Skipped",
};
export const cleanupStatusLabel = (status: CleanupStatus) => CLEANUP_STATUS[status];
