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
export const cleanupRejectedMessage = (reason: string) =>
  `The cleanup was not sent${reason ? `: ${reason.replace(/[.\s]+$/, "")}` : ""}. Nothing was closed; retry the cleanup or use the recovery page.`;

/** Codes that are worth a Sentry event: a result the user could not have caused or fixed. Declines and still-confirming are not. */
export const REPORTABLE_CLEANUP_REASONS: readonly CleanupFailureReason[] = ["expired-unlanded", "chain-failed", "rejected-before-send", "needs-review"];

export type CleanupOutcomeInput = {
  durable: CleanupBatchAttempt | null;
  /** The message of an exception that stopped the flow (wallet, fence, preparation); wins over the settled state for the row text. */
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
  if (thrown) return { status: "failed", error: thrown, reason: "stopped", ...flag, ...withDetail };
  if (!durable) return { status: "failed", error: CLEANUP_DID_NOT_COMPLETE, reason: "unknown", ...withDetail };
  const sent = durable.transactions.filter((tx) => !tx.unsent);
  if (sent.some((tx) => tx.status === "expired")) return { status: "failed", error: CLEANUP_EXPIRED, reason: "expired-unlanded", ...withDetail };
  if (sent.some((tx) => tx.status === "failed")) return { status: "failed", error: CLEANUP_CHAIN_FAILED, reason: "chain-failed", ...withDetail };
  if (durable.transactions.some((tx) => tx.unsent)) {
    const rejected = issues.find((issue) => issue.kind === "rejected");
    return { status: "failed", error: cleanupRejectedMessage(rejected?.message ?? ""), reason: "rejected-before-send", ...withDetail };
  }
  if (sent.some((tx) => tx.status === "manual-review")) return { status: "failed", error: CLEANUP_NEEDS_REVIEW, reason: "needs-review", ...flag, ...withDetail };
  if (unconfirmed) return { status: "failed", error: CLEANUP_STILL_CONFIRMING, reason: "still-confirming", ...flag, ...withDetail };
  return { status: "failed", error: CLEANUP_DID_NOT_COMPLETE, reason: "unknown", ...withDetail };
}
