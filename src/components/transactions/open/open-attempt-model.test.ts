import { describe, expect, it } from "vitest";
import type { OpenAttempt } from "@/lib/open-attempt";
import { openAttemptPending, openAttemptReducer, UNLOADED_OPEN_ATTEMPT, visibleOpenAttempt, type OpenAttemptState } from "./open-attempt-model";

// The model consumes already validated data; validation/storage stay at the existing boundary.
const attempt = Object.freeze({ wallet: "wallet-a", signature: "original" }) as OpenAttempt;
describe("Open history projections and immutable queue semantics", () => {
  it("wallet filtering blocks an unloaded wallet and never exposes another wallet's history", () => {
    const tracked = openAttemptReducer(UNLOADED_OPEN_ATTEMPT, { type: "attemptTracked", attempt });
    expect(visibleOpenAttempt(tracked, "wallet-b")).toBeNull();
    expect(openAttemptPending(visibleOpenAttempt(tracked, "wallet-b"), "wallet-b")).toBe(true);
    expect(openAttemptPending(null, undefined)).toBe(false);
    expect(openAttemptPending(visibleOpenAttempt(tracked, "wallet-a"), "wallet-a")).toBe(true);
  });
  it("dismissal preserves a frozen receipt and functional failure applies to the latest queued state", () => {
    const terminal = Object.freeze({ kind: "tracked", wallet: attempt.wallet, attempt, status: "confirmed", error: "" }) satisfies OpenAttemptState;
    const next = openAttemptReducer(terminal, { type: "terminalDismissed", snapshot: terminal });
    const failed = openAttemptReducer(next, { type: "verificationFailed", error: "offline" });
    expect(failed).toMatchObject({ attempt, status: null, error: "offline" });
    expect(terminal.status).toBe("confirmed"); expect(next).toMatchObject({ status: null, error: "" });
    expect(openAttemptPending(visibleOpenAttempt(failed, attempt.wallet), attempt.wallet)).toBe(false);
  });
  it("an error cannot imply unsent or discard an unresolved original signature", () => {
    const pending = openAttemptReducer(UNLOADED_OPEN_ATTEMPT, { type: "attemptTracked", attempt });
    for (const error of ["lost response", "signature mismatch", "timeout"]) {
      const next = openAttemptReducer(pending, { type: "verificationFailed", error });
      expect(next).toMatchObject({ attempt, status: "pending", error });
      expect(openAttemptPending(visibleOpenAttempt(next, attempt.wallet), attempt.wallet)).toBe(true);
    }
  });
});
