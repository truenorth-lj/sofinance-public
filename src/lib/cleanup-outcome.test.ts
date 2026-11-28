import { describe, expect, it } from "vitest";
import { CLEANUP_CHAIN_FAILED, CLEANUP_EXPIRED, CLEANUP_NEEDS_REVIEW, REPORTABLE_CLEANUP_REASONS, cleanupOutcome, cleanupRejectedMessage } from "./cleanup-outcome";
import { CLEANUP_DID_NOT_COMPLETE, CLEANUP_STILL_CONFIRMING } from "./compound-cleanup-settlement";
import type { CleanupBatchAttempt, CleanupBatchTransaction } from "./compound-cleanup-batch-attempt";

const tx = (over: Partial<CleanupBatchTransaction> = {}): CleanupBatchTransaction => ({
  signature: over.signature ?? "sig-a", status: over.status ?? "pending",
  summary: over.summary ?? ({ compoundAccounts: [] } as unknown as CleanupBatchTransaction["summary"]), ...over,
});
const batch = (...transactions: CleanupBatchTransaction[]): CleanupBatchAttempt => ({
  version: 1, wallet: "w", createdAt: 1, receipts: [], alreadyClosed: [], transactions,
});

describe("cleanupOutcome: the reason code and row text for a cleanup batch", () => {
  it("is done with the sent signatures when every sent transaction succeeded", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "success" }), tx({ signature: "sig-b", status: "success" })) }))
      .toEqual({ status: "done", signatures: ["sig-a", "sig-b"] });
    expect(cleanupOutcome({ durable: batch() })).toEqual({ status: "done", signatures: [] });
  });
  it("names an expired, never-landed transaction (the 11/28 case) instead of the generic text", () => {
    const outcome = cleanupOutcome({ durable: batch(tx({ status: "expired", chainStatus: "expired" })) });
    expect(outcome).toEqual({ status: "failed", error: CLEANUP_EXPIRED, reason: "expired-unlanded" });
    expect(CLEANUP_EXPIRED).toContain("nothing was closed");
    expect(outcome).not.toHaveProperty("outcomeUnconfirmed");
  });
  it("names a landed failure", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "failed" })) })).toEqual({ status: "failed", error: CLEANUP_CHAIN_FAILED, reason: "chain-failed" });
  });
  it("shows the server's reason when it refused to send, and says nothing was closed", () => {
    const outcome = cleanupOutcome({ durable: batch(tx({ status: "failed", unsent: true })),
      issues: [{ signature: "sig-a", kind: "rejected", message: "Cleanup transaction simulation failed" }] });
    expect(outcome).toMatchObject({ status: "failed", reason: "rejected-before-send", error: cleanupRejectedMessage("Cleanup transaction simulation failed") });
    expect((outcome as { error: string }).error).toContain("Cleanup transaction simulation failed");
    expect((outcome as { error: string }).error).toContain("Nothing was closed");
  });
  it("does not duplicate the final period of a server message", () => {
    expect(cleanupRejectedMessage("Cleanup authorization expired or blockhash mismatch.")).toBe(
      "The cleanup was not sent: Cleanup authorization expired or blockhash mismatch. Nothing was closed; retry the cleanup or use the recovery page.");
    expect(cleanupRejectedMessage("")).toContain("The cleanup was not sent.");
  });
  it("keeps a thrown stop reason as the row text and tags it stopped", () => {
    expect(cleanupOutcome({ durable: null, thrown: "Wallet, position, or authorization changed; cleanup stopped" }))
      .toEqual({ status: "failed", error: "Wallet, position, or authorization changed; cleanup stopped", reason: "stopped" });
  });
  it("keeps the unconfirmed flag when a stop leaves a signature still pending", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "pending" })), thrown: "Cleanup stopped" })).toMatchObject({ reason: "stopped", outcomeUnconfirmed: true });
  });
  it("says still confirming for a pending batch, and needs review for a result that did not match", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "pending" })) })).toEqual({ status: "failed", error: CLEANUP_STILL_CONFIRMING, reason: "still-confirming", outcomeUnconfirmed: true });
    expect(cleanupOutcome({ durable: batch(tx({ status: "manual-review" })) })).toEqual({ status: "failed", error: CLEANUP_NEEDS_REVIEW, reason: "needs-review", outcomeUnconfirmed: true });
  });
  it("prefers the definite on-chain result over a softer one in a mixed batch", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "success" }), tx({ signature: "b", status: "expired" })) })).toMatchObject({ reason: "expired-unlanded" });
    expect(cleanupOutcome({ durable: batch(tx({ status: "expired" }), tx({ signature: "b", status: "failed" })) })).toMatchObject({ reason: "expired-unlanded" });
    expect(cleanupOutcome({ durable: batch(tx({ status: "failed" }), tx({ signature: "b", status: "pending", unsent: false })) })).toMatchObject({ reason: "chain-failed" });
  });
  it("records the unknown send outcomes that came before an expiry, for support", () => {
    const outcome = cleanupOutcome({ durable: batch(tx({ status: "expired" })),
      issues: [{ signature: "sig-a", kind: "unknown", message: "The operation was aborted due to timeout" }] });
    expect(outcome).toMatchObject({ reason: "expired-unlanded", detail: "unknown: The operation was aborted due to timeout" });
  });
  it("falls back to the generic text only when nothing explains the failure", () => {
    expect(cleanupOutcome({ durable: null })).toEqual({ status: "failed", error: CLEANUP_DID_NOT_COMPLETE, reason: "unknown" });
  });
  it("reports to Sentry only results the user could not cause", () => {
    expect([...REPORTABLE_CLEANUP_REASONS].sort()).toEqual(["chain-failed", "expired-unlanded", "needs-review", "rejected-before-send"]);
  });
});
