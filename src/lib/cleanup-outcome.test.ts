import { describe, expect, it } from "vitest";
import { CLEANUP_CHAIN_FAILED, CLEANUP_EXPIRED, CLEANUP_NEEDS_REVIEW, CLEANUP_PARTIAL_UNSENT, REPORTABLE_CLEANUP_REASONS, cleanupOutcome, cleanupRejectedMessage } from "./cleanup-outcome";
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
  it("keeps a thrown stop reason as the row text and tags it stopped, when nothing settled on-chain", () => {
    expect(cleanupOutcome({ durable: null, thrown: "Wallet, position, or authorization changed; cleanup stopped" }))
      .toEqual({ status: "failed", error: "Wallet, position, or authorization changed; cleanup stopped", reason: "stopped" });
  });
  it("prefers a definite expired or chain-failed result over a later thrown stop", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "expired", chainStatus: "expired" })), thrown: "Cleanup verification will retry" }))
      .toMatchObject({ reason: "expired-unlanded", error: CLEANUP_EXPIRED });
    expect(cleanupOutcome({ durable: batch(tx({ status: "failed" })), thrown: "Cleanup stopped" }))
      .toMatchObject({ reason: "chain-failed", error: CLEANUP_CHAIN_FAILED });
  });
  it("keeps a still-pending sent transaction unconfirmed, even if a stop was thrown", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "pending" })), thrown: "Cleanup stopped" })).toMatchObject({ reason: "still-confirming", outcomeUnconfirmed: true });
  });
  it("stays unconfirmed (no Retry) while a sent chunk is still pending or needs review, even if others were unsent", () => {
    const pendingAndUnsent = cleanupOutcome({
      durable: batch(tx({ status: "pending" }), tx({ signature: "sig-b", status: "failed", unsent: true })),
    });
    expect(pendingAndUnsent).toMatchObject({ status: "failed", reason: "still-confirming", error: CLEANUP_STILL_CONFIRMING, outcomeUnconfirmed: true });
    const successPendingUnsent = cleanupOutcome({
      durable: batch(tx({ status: "success" }), tx({ signature: "sig-b", status: "pending" }), tx({ signature: "sig-c", status: "failed", unsent: true })),
    });
    expect(successPendingUnsent).toMatchObject({ reason: "still-confirming", outcomeUnconfirmed: true });
    const reviewAndUnsent = cleanupOutcome({
      durable: batch(tx({ status: "manual-review" }), tx({ signature: "sig-b", status: "failed", unsent: true })),
    });
    expect(reviewAndUnsent).toMatchObject({ status: "failed", reason: "needs-review", error: CLEANUP_NEEDS_REVIEW, outcomeUnconfirmed: true });
  });
  it("gives partial-unsent only after every sent chunk has settled", () => {
    const outcome = cleanupOutcome({ durable: batch(tx({ status: "success" }), tx({ signature: "sig-b", status: "failed", unsent: true })),
      issues: [{ signature: "sig-b", kind: "rejected", message: "Cleanup transaction simulation failed" }] });
    expect(outcome).toMatchObject({ status: "failed", reason: "partial-unsent", error: CLEANUP_PARTIAL_UNSENT });
    expect(outcome).not.toHaveProperty("outcomeUnconfirmed");
  });
  it("says still confirming for a pending batch, and needs review for a result that did not match", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "pending" })) })).toEqual({ status: "failed", error: CLEANUP_STILL_CONFIRMING, reason: "still-confirming", outcomeUnconfirmed: true });
    expect(cleanupOutcome({ durable: batch(tx({ status: "manual-review" })) })).toEqual({ status: "failed", error: CLEANUP_NEEDS_REVIEW, reason: "needs-review", outcomeUnconfirmed: true });
  });
  it("prefers the definite on-chain result over a softer one in a mixed batch, but stays unconfirmed while any sent tx is still pending", () => {
    expect(cleanupOutcome({ durable: batch(tx({ status: "success" }), tx({ signature: "b", status: "expired" })) })).toMatchObject({ reason: "expired-unlanded" });
    expect(cleanupOutcome({ durable: batch(tx({ status: "expired" }), tx({ signature: "b", status: "failed" })) })).toMatchObject({ reason: "expired-unlanded" });
    expect(cleanupOutcome({ durable: batch(tx({ status: "failed" }), tx({ signature: "b", status: "pending", unsent: false })) }))
      .toMatchObject({ reason: "still-confirming", outcomeUnconfirmed: true });
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
    expect([...REPORTABLE_CLEANUP_REASONS].sort()).toEqual(["chain-failed", "expired-unlanded", "needs-review", "partial-unsent", "rejected-before-send"]);
  });
});
