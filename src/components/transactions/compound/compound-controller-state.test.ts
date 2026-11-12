import { describe, expect, it } from "vitest";
import type { CompoundAttempt, CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundConfirmation } from "./use-compound-attempt";
import {
  compoundControllerReducer, emptyCompoundError, emptyCompoundScan, initialCompoundControllerState,
  type CompoundControllerState, type CompoundCleanupProgress, type CompoundSubmitFeedback,
} from "./compound-controller-state";

const attempt = { version: 1, wallet: "W", positionMint: "M", signature: "sig", kind: "compound" } as CompoundAttempt;
const recovery = { ...attempt, kind: "recovery", signature: "rec" } as CompoundAttempt;
const receipt = { wallet: "W", positionMint: "M", sourceSignature: "sig", compoundAccounts: [] } as unknown as CompoundReceipt;
const confirmation = { status: "success", signature: "sig", state: null, chainStatus: "success" } as CompoundConfirmation;

function reduce(actions: Parameters<typeof compoundControllerReducer>[1][], start: CompoundControllerState = initialCompoundControllerState) {
  return actions.reduce(compoundControllerReducer, start);
}

describe("compoundControllerReducer", () => {
  it("resets session UI then loads a verified saved attempt as pending", () => {
    const dirty: CompoundControllerState = {
      ...initialCompoundControllerState,
      stage: "wallet",
      scan: { ...emptyCompoundScan, started: true, scanned: 3 },
      cleanup: { completed: 0, total: 1, running: true, message: "x" },
      preview: { positionMint: "M" } as CompoundSummary,
      feedback: { phase: "failed", signature: "old", message: "no" },
      error: { message: "stale", identity: "W:M", signature: "old", receiptSignature: null },
    };
    const state = reduce([
      { type: "wallet/reset-session" },
      { type: "wallet/loaded", wallet: "W", attempt, receipts: [receipt], invalid: false },
    ], dirty);
    expect(state).toMatchObject({
      stage: null, scan: emptyCompoundScan, cleanup: null, preview: null, confirmation: null,
      chainStatus: null, confirmationSlow: false, error: emptyCompoundError, feedback: null,
      attempt, receipts: [receipt], storageInvalid: false, attemptStatus: "pending", loadedWallet: "W",
    });
  });

  it("marks unverifiable or unreadable local history as manual-review", () => {
    expect(reduce([
      { type: "wallet/reset-session" },
      { type: "wallet/loaded", wallet: "W", attempt, receipts: [], invalid: true },
    ])).toMatchObject({
      attempt, storageInvalid: true, attemptStatus: "manual-review", loadedWallet: "W",
      error: { message: "Local compound history cannot be verified. Check the original transaction and balance accounts before repeating an earlier operation." },
    });
    expect(reduce([
      { type: "wallet/reset-session" },
      { type: "wallet/load-failed", wallet: "W" },
    ])).toMatchObject({
      attempt: null, receipts: [], storageInvalid: true, attemptStatus: "manual-review", loadedWallet: "W",
      error: { message: "Unable to read local compound history. Check previous signatures before repeating an earlier operation." },
    });
  });

  it("clears attempt history when the wallet disconnects after a session reset", () => {
    const loaded = reduce([
      { type: "wallet/loaded", wallet: "W", attempt, receipts: [receipt], invalid: false },
    ]);
    expect(reduce([{ type: "wallet/reset-session" }, { type: "wallet/cleared" }], loaded)).toMatchObject({
      attempt: null, attemptStatus: null, receipts: [], loadedWallet: null, storageInvalid: false,
    });
  });

  it("clears only the in-flight stage and cleanup when the selection lifecycle moves on", () => {
    const state = reduce([{ type: "operation/clear-stage-cleanup" }], {
      ...initialCompoundControllerState, stage: "broadcasting",
      cleanup: { completed: 1, total: 2, running: true, message: "go" },
      attempt, attemptStatus: "pending",
    });
    expect(state.stage).toBeNull();
    expect(state.cleanup).toBeNull();
    expect(state.attempt).toEqual(attempt);
    expect(state.attemptStatus).toBe("pending");
  });

  it("records a confirmation observation and clears a matching submit error only when asked", () => {
    const withError: CompoundControllerState = {
      ...initialCompoundControllerState,
      error: { message: "wait", identity: "W:M", signature: "sig", receiptSignature: null },
    };
    const observed = reduce([{
      type: "confirmation/observed", status: "success", confirmation, chainStatus: "success",
    }], withError);
    expect(observed).toMatchObject({ attemptStatus: "success", confirmation, chainStatus: "success" });
    expect(observed.error.message).toBe("wait");
    expect(reduce([{ type: "confirmation/clear-submit-error", identity: "W:M", signature: "other" }], observed).error.message).toBe("wait");
    expect(reduce([{ type: "confirmation/clear-submit-error", identity: "W:M", signature: "sig" }], observed).error).toEqual(emptyCompoundError);
  });

  it("clears the compound preview and sets success or failure feedback on a terminal result", () => {
    const start: CompoundControllerState = {
      ...initialCompoundControllerState,
      preview: { positionMint: "M" } as CompoundSummary,
      feedback: { phase: "confirming", signature: "sig", message: "" },
    };
    expect(reduce([
      { type: "confirmation/clear-preview" },
      { type: "feedback/update", signature: "sig", next: { phase: "success", message: "" } },
    ], start)).toMatchObject({ preview: null, feedback: { phase: "success", signature: "sig", message: "" } });
    expect(reduce([{
      type: "feedback/update", signature: "sig",
      next: { phase: "failed", message: "The transaction did not land before it expired. No fees were moved; you can try again." },
    }], start).feedback?.message).toMatch(/did not land before it expired/);
    expect(reduce([{ type: "feedback/update", signature: "other", next: { phase: "success", message: "" } }], start).feedback?.phase)
      .toBe("confirming");
  });

  it("advances a finished recovery cleanup message only when cleanup is not still running", () => {
    const progress = (running: boolean): CompoundCleanupProgress => (
      { completed: 1, total: 3, running, message: "working", compoundSignature: "sig" }
    );
    expect(reduce([{ type: "confirmation/recovery-progress" }], { ...initialCompoundControllerState, cleanup: progress(false) }).cleanup)
      .toEqual({ completed: 2, total: 3, running: false, message: "Balance merged and account rent recovered. The saved transaction is confirmed on-chain.", compoundSignature: "sig" });
    expect(reduce([{ type: "confirmation/recovery-progress" }], { ...initialCompoundControllerState, cleanup: progress(true) }).cleanup)
      .toEqual(progress(true));
    expect(reduce([{ type: "confirmation/recovery-progress" }]).cleanup).toBeNull();
  });

  it("returns confirmation reads to pending and records or clears the error", () => {
    expect(reduce([{ type: "confirmation/read-failed", message: "mismatch", identity: "W:M", signature: "sig" }]))
      .toMatchObject({ attemptStatus: "pending", error: { message: "mismatch", identity: "W:M", signature: "sig", receiptSignature: null } });
    expect(reduce([{ type: "confirmation/read-failed", message: "", identity: "W:M", signature: "sig" }], {
      ...initialCompoundControllerState,
      error: { message: "old", identity: "W:M", signature: "sig", receiptSignature: null },
    })).toMatchObject({ attemptStatus: "pending", error: emptyCompoundError });
  });

  it("starts submit as preparing, then records a persisted compound as pending with confirming feedback", () => {
    const prepared = reduce([{ type: "submit/prepare" }], {
      ...initialCompoundControllerState,
      error: { message: "old", identity: "W:M", signature: null, receiptSignature: null },
      confirmation,
    });
    expect(prepared).toMatchObject({ stage: "preparing", error: emptyCompoundError, confirmation: null });
    const persisted = reduce([{
      type: "submit/persisted", attempt, receipts: [receipt],
      feedback: { phase: "confirming", signature: "sig", message: "" },
    }], prepared);
    expect(persisted).toMatchObject({
      attempt, attemptStatus: "pending", chainStatus: "pending", confirmationSlow: false,
      receipts: [receipt], stage: "broadcasting",
      feedback: { phase: "confirming", signature: "sig", message: "" },
    });
  });

  it("does not touch an existing feedback dialog when a recovery attempt is persisted", () => {
    const feedback: CompoundSubmitFeedback = { phase: "confirming", signature: "sig", message: "" };
    const state = reduce([{ type: "submit/persisted", attempt: recovery, receipts: [] }], {
      ...initialCompoundControllerState, feedback,
    });
    expect(state.attempt).toEqual(recovery);
    expect(state.feedback).toEqual(feedback);
  });

  it("abandons an unsent attempt and keeps a functional cleanup/scan/error patch", () => {
    const start = reduce([{ type: "submit/persisted", attempt, receipts: [receipt] }]);
    expect(reduce([{ type: "submit/abandoned", receipts: [] }], start)).toMatchObject({
      attempt: null, attemptStatus: null, confirmation: null, chainStatus: null, confirmationSlow: false, receipts: [],
    });
    expect(reduce([{ type: "cleanup/set", cleanup: null }, { type: "confirmation/slow" }, { type: "importing/set", importing: true }], start))
      .toMatchObject({ cleanup: null, confirmationSlow: true, importing: true });
    const scanned = reduce([
      { type: "scan/patch", updater: (previous) => ({ ...previous, started: true, scanning: true, error: "" }) },
      { type: "scan/set", scan: { ...emptyCompoundScan, started: true, scanned: 4, total: 4 } },
    ]);
    expect(scanned.scan).toEqual({ ...emptyCompoundScan, started: true, scanned: 4, total: 4 });
    expect(reduce([{ type: "error/set", error: { message: "x", identity: "W:M", signature: null, receiptSignature: null } },
      { type: "error/clear", identity: "W:M", signature: "other" }]).error.message).toBe("x");
    expect(reduce([{ type: "error/set", error: { message: "x", identity: "W:M", signature: null, receiptSignature: null } },
      { type: "error/clear", identity: "W:M", signature: null }]).error).toEqual(emptyCompoundError);
  });
});
