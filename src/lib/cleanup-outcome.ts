import type { CleanupBatchAttempt } from "./compound-cleanup-batch-attempt";
import { CLEANUP_DID_NOT_COMPLETE, CLEANUP_STILL_CONFIRMING, cleanupBatchSettlement, cleanupOutcomeUnconfirmed } from "./compound-cleanup-settlement";

/**
 * Why a cleanup batch did not finish. One code per failure so the row can say what happened, support can search for
 * it, and Sentry groups by it. Pure: no React, no network, no storage.
 */
export type CleanupFailureReason =
  /** Signed and sent, but never landed before its blockhash expired. Nothing was closed. */
  | "expired-unlanded"
  /** The transaction landed and failed. Nothing was closed (the transaction is atomic). */
  | "chain-failed"
  /** The server refused to send it (simulation, authorization or expiry check). Nothing was sent. */
  | "rejected-before-send"
  /** Landed, but the receipt did not match what was approved. Needs a look in Activity. */
  | "needs-review"
  /** Still being confirmed when the wait ended; it may yet land. */
  | "still-confirming"
  /** Some chunks confirmed and others were never sent; remaining harvest accounts are still open. */
  | "partial-unsent"
  /** Stopped before or around signing: wallet declined, records or wallet changed, preparation refused. */
  | "stopped"
  /** Nothing explains it. Should not happen. */
  | "unknown";

/** A broadcast request that did not return a signature. `rejected` = the server said it sent nothing; `unknown` = outcome not known. */
export type CleanupBroadcastIssue = { signature: string; kind: "rejected" | "unknown"; message: string };

export type CleanupBatchOutcome =
  | { status: "done"; signatures: string[] }
  | { status: "refused"; error: string; reason?: CleanupFailureReason }
  | { status: "failed"; error: string; reason: CleanupFailureReason; outcomeUnconfirmed?: boolean; detail?: string };

export const CLEANUP_EXPIRED = "The cleanup transaction was signed but never landed on Solana before it expired, so nothing was closed. Your balances and rent are still in the harvest accounts.";
export const CLEANUP_CHAIN_FAILED = "The cleanup transaction failed on Solana, so nothing was closed. Your balances and rent are still in the harvest accounts.";
export const CLEANUP_NEEDS_REVIEW = "The cleanup landed but its result needs verification. Check it in Activity before trying again.";
export const CLEANUP_PARTIAL_UNSENT = "Some cleanup transactions confirmed, but others were not sent, so some harvest accounts are still open. Retry the cleanup or use the recovery page.";
export const cleanupRejectedMessage = (reason: string) =>
  `The cleanup was not sent${reason ? `: ${reason.replace(/[.\s]+$/, "")}` : ""}. Nothing was closed; retry the cleanup or use the recovery page.`;

/** Codes that are worth a Sentry event: a result the user could not have caused or fixed. Declines and still-confirming are not. */
export const REPORTABLE_CLEANUP_REASONS: readonly CleanupFailureReason[] = ["expired-unlanded", "chain-failed", "rejected-before-send", "needs-review", "partial-unsent"];

export type CleanupOutcomeInput = {
  durable: CleanupBatchAttempt | null;
  /** Exception text (wallet, fence, preparation). Used only when nothing sent has a definite or still-pending result. */
  thrown?: string;
  issues?: readonly CleanupBroadcastIssue[];
};

function describeIssues(issues: readonly CleanupBroadcastIssue[]) {
  return issues.length ? issues.map((issue) => `${issue.kind}: ${issue.message}`).join("; ").slice(0, 300) : undefined;
}

/** The one place the cleanup row text and reason code are decided. */
export function cleanupOutcome({ durable, thrown = "", issues = [] }: CleanupOutcomeInput): CleanupBatchOutcome {
  if (durable && cleanupBatchSettlement(durable) === "success") {
    return { status: "done", signatures: durable.transactions.filter((tx) => !tx.unsent).map((tx) => tx.signature) };
  }
  const detail = describeIssues(issues);
  const unconfirmed = durable ? cleanupOutcomeUnconfirmed(durable) : false;
  const flag = unconfirmed ? { outcomeUnconfirmed: true as const } : {};
  const withDetail = detail ? { detail } : {};
  if (!durable) {
    if (thrown) return { status: "failed", error: thrown, reason: "stopped", ...flag, ...withDetail };
    return { status: "failed", error: CLEANUP_DID_NOT_COMPLETE, reason: "unknown", ...withDetail };
  }
  const sent = durable.transactions.filter((tx) => !tx.unsent);
  // A sent transaction that may still land (or needs review) beats unsent/expired/failed: no Retry until every
  // sent chunk has settled. Otherwise a pending + unsent batch would show Failed + Retry (the #540 hole).
  if (sent.some((tx) => tx.status === "pending")) return { status: "failed", error: CLEANUP_STILL_CONFIRMING, reason: "still-confirming", outcomeUnconfirmed: true, ...withDetail };
  if (sent.some((tx) => tx.status === "manual-review")) return { status: "failed", error: CLEANUP_NEEDS_REVIEW, reason: "needs-review", outcomeUnconfirmed: true, ...withDetail };
  // A definite on-chain result beats a later thrown stop (confirm timeout, tab change after expiry).
  if (sent.some((tx) => tx.status === "expired")) return { status: "failed", error: CLEANUP_EXPIRED, reason: "expired-unlanded", ...withDetail };
  if (sent.some((tx) => tx.status === "failed" && !tx.unsent)) return { status: "failed", error: CLEANUP_CHAIN_FAILED, reason: "chain-failed", ...withDetail };
  if (durable.transactions.some((tx) => tx.unsent)) {
    const rejected = issues.find((issue) => issue.kind === "rejected");
    const partial = sent.some((tx) => tx.status === "success");
    return { status: "failed", error: partial ? CLEANUP_PARTIAL_UNSENT : cleanupRejectedMessage(rejected?.message ?? ""),
      reason: partial ? "partial-unsent" : "rejected-before-send", ...withDetail };
  }
  if (thrown) return { status: "failed", error: thrown, reason: "stopped", ...flag, ...withDetail };
  if (unconfirmed) return { status: "failed", error: CLEANUP_STILL_CONFIRMING, reason: "still-confirming", ...flag, ...withDetail };
  return { status: "failed", error: CLEANUP_DID_NOT_COMPLETE, reason: "unknown", ...withDetail };
}
