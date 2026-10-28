import type { OpenAttempt, OpenAttemptStatus } from "@/lib/open-attempt";

/** In-memory history only. Storage's OpenAttempt v1 remains the durable contract. */
export type OpenAttemptState =
  | { kind: "unloaded" }
  | { kind: "empty"; wallet: string; attempt: null; status: null; error: string }
  | { kind: "invalid"; wallet: string; attempt: null; status: "manual-review"; error: string }
  | { kind: "tracked"; wallet: string; attempt: OpenAttempt; status: OpenAttemptStatus | null; error: string };
type LoadedState = Exclude<OpenAttemptState, { kind: "unloaded" }>;
type DismissibleState = Extract<LoadedState, { kind: "empty" | "tracked" }>;

export type OpenAttemptEvent =
  | { type: "historyLoaded"; wallet: string; attempt: OpenAttempt | null; invalid: boolean }
  | { type: "historyUnavailable"; wallet: string }
  | { type: "attemptTracked"; attempt: OpenAttempt }
  | { type: "statusObserved"; attempt: OpenAttempt; status: OpenAttemptStatus }
  | { type: "markedUnsent"; attempt: OpenAttempt }
  | { type: "verificationFailed"; error: string }
  // Dismissal intentionally replaces from the invoking render, unlike functional errors.
  | { type: "terminalDismissed"; snapshot: DismissibleState };

export const UNLOADED_OPEN_ATTEMPT: OpenAttemptState = { kind: "unloaded" };

function tracked(attempt: OpenAttempt, status: OpenAttemptStatus): OpenAttemptState {
  return { kind: "tracked", wallet: attempt.wallet, attempt, status,
    error: status === "failed" ? "Open-position transaction failed on-chain. You can prepare a new transaction."
      : status === "expired" ? "Open-position transaction expired without landing. You can prepare a new transaction."
        : status === "manual-review" ? "The original transaction needs manual verification. Check its signature before opening again." : "" };
}

/** No ownership decisions or I/O here: the hook retains its synchronous fences. */
export function openAttemptReducer(state: OpenAttemptState, event: OpenAttemptEvent): OpenAttemptState {
  switch (event.type) {
    case "historyLoaded":
      if (event.invalid) return { kind: "invalid", wallet: event.wallet, attempt: null, status: "manual-review",
        error: "Local open-position history cannot be verified. Check previous signatures before opening again." };
      return event.attempt ? tracked(event.attempt, "pending")
        : { kind: "empty", wallet: event.wallet, attempt: null, status: null, error: "" };
    case "historyUnavailable":
      return { kind: "invalid", wallet: event.wallet, attempt: null, status: "manual-review",
        error: "Unable to read open-position history. Check previous signatures before opening again." };
    case "attemptTracked": return tracked(event.attempt, "pending");
    case "statusObserved": return tracked(event.attempt, event.status);
    case "markedUnsent": return tracked(event.attempt, "unsent");
    case "verificationFailed":
      return state.kind === "unloaded" ? state : { ...state, error: event.error };
    case "terminalDismissed":
      return { ...event.snapshot, status: null, error: "" };
  }
}

export function visibleOpenAttempt(state: OpenAttemptState, wallet: string | undefined): LoadedState | null {
  return state.kind !== "unloaded" && state.wallet === wallet ? state : null;
}

export function openAttemptPending(visible: LoadedState | null, wallet: string | undefined): boolean {
  return Boolean(wallet && (!visible || visible.kind === "invalid" || visible.status === "pending" || visible.status === "manual-review"));
}
