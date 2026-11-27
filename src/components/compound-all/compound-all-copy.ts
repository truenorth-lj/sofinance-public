import { summarizeCompoundAll, type CleanupStatus, type CompoundAllRow, type CompoundAllState, type RowStatus } from "@/lib/compound-all/state";

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
  didNotCompound: "This position did not compound.",
  retryOrSkip: " Try it again, or skip it.",
  skipOnly: " Skip it to go on.",
  unconfirmed: "This position's result isn't confirmed yet. Skip it to go on; check Portfolio later.",
  allDone: "All done.",
  finished: "Finished.",
  stopped: "Stopped.",
  couldntSend: "Couldn't send",
  unconfirmedLabel: "Unconfirmed",
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
export const rowStatusLabel = (row: Pick<CompoundAllRow, "status" | "selected" | "couldntSend" | "outcomeUnconfirmed">) => {
  if (!row.selected) return "Not selected";
  // A non-explicit wallet error (not the user's "no") whose send may still land: never "Rejected in wallet".
  if (row.status === "failed" && row.couldntSend) return COMPOUND_ALL_COPY.couldntSend;
  // Still confirming, or a result that may already be on-chain: never "Failed" (a Failed label invites a duplicate send).
  if (row.status === "failed" && row.outcomeUnconfirmed) return COMPOUND_ALL_COPY.unconfirmedLabel;
  return ROW_STATUS[row.status];
};

/** A failed row whose transaction may still land: Skip only, and the pause must not say it didn't compound. */
export function rowResultUnconfirmed(row: Pick<CompoundAllRow, "status" | "retryable" | "outcomeUnconfirmed">) {
  return row.status === "failed" && row.retryable === false && row.outcomeUnconfirmed === true;
}

/** "All done." only when every selected row compounded and the cleanup (if any) was sent; otherwise "Finished." (or "Stopped."). */
export function summaryHeading(state: CompoundAllState) {
  if (state.phase === "cancelled" || state.cancelled) return COMPOUND_ALL_COPY.stopped;
  const summary = summarizeCompoundAll(state);
  const cleanupOk = summary.cleanup === "none" || summary.cleanup === "done";
  return summary.failed === 0 && summary.skipped === 0 && summary.notSigned === 0 && summary.done === summary.selected && cleanupOk
    ? COMPOUND_ALL_COPY.allDone : COMPOUND_ALL_COPY.finished;
}

const CLEANUP_STATUS: Record<CleanupStatus, string> = {
  none: "Waiting", pending: "Waiting", offered: "Ready", preparing: "Preparing…", "awaiting-wallet": "Approve in your wallet",
  confirming: "Confirming…", done: "Done", failed: "Failed", skipped: "Skipped",
};
export const cleanupStatusLabel = (status: CleanupStatus, outcomeUnconfirmed?: boolean) =>
  status === "failed" && outcomeUnconfirmed ? COMPOUND_ALL_COPY.unconfirmedLabel : CLEANUP_STATUS[status];

/** Completion tiles: unconfirmed rows are not counted as "Did not complete". */
export function summaryItems(state: CompoundAllState): [string, number][] {
  const summary = summarizeCompoundAll(state);
  const unconfirmed = state.rows.filter((row) => row.selected && rowResultUnconfirmed(row)).length;
  return [
    ["Compounded", summary.done],
    ["Skipped", summary.skipped],
    ["Not signed", summary.notSigned],
    ["Unconfirmed", unconfirmed],
    ["Did not complete", summary.failed - unconfirmed],
  ];
}
