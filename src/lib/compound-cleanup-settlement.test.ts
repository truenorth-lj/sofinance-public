import { describe, expect, it } from "vitest";
import { cleanupBatchSettlement } from "./compound-cleanup-settlement";
import type { CleanupBatchAttempt, CleanupBatchTransaction } from "./compound-cleanup-batch-attempt";

const tx = (over: Partial<CleanupBatchTransaction> = {}): CleanupBatchTransaction => ({
  signature: over.signature ?? "sig", status: over.status ?? "pending",
  summary: over.summary ?? ({ compoundAccounts: [] } as unknown as CleanupBatchTransaction["summary"]),
  ...over,
});
const batch = (transactions: CleanupBatchTransaction[]): CleanupBatchAttempt => ({
  version: 1, wallet: "w", createdAt: 1, receipts: [], alreadyClosed: [], transactions,
});

describe("cleanupBatchSettlement", () => {
  it("is success when every account was already closed (no transactions to confirm)", () => {
    expect(cleanupBatchSettlement(batch([]))).toBe("success");
  });
  it("is success only when every sent transaction has confirmed on-chain", () => {
    expect(cleanupBatchSettlement(batch([tx({ status: "success" }), tx({ signature: "b", status: "success" })]))).toBe("success");
    expect(cleanupBatchSettlement(batch([tx({ status: "success" }), tx({ signature: "b", status: "pending" })]))).toBe("pending");
  });
  it("is failed for an on-chain failure, expiry, or manual review — the row must not be marked done", () => {
    expect(cleanupBatchSettlement(batch([tx({ status: "failed" })]))).toBe("failed");
    expect(cleanupBatchSettlement(batch([tx({ status: "expired" })]))).toBe("failed");
    expect(cleanupBatchSettlement(batch([tx({ status: "manual-review" })]))).toBe("failed");
    expect(cleanupBatchSettlement(batch([tx({ status: "success" }), tx({ signature: "b", status: "failed" })]))).toBe("failed");
  });
  it("ignores unsent transactions when judging a mixed batch, and fails when nothing was sent", () => {
    expect(cleanupBatchSettlement(batch([tx({ status: "success" }), tx({ signature: "b", status: "failed", unsent: true })]))).toBe("success");
    expect(cleanupBatchSettlement(batch([tx({ status: "failed", unsent: true })]))).toBe("failed");
  });
});
