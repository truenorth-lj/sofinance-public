import type { CleanupFailureReason } from "@/lib/cleanup-outcome";
import {
  compoundAllApprovals, compoundAllReducer, createCompoundAllState, nextQueuedRow, summarizeCompoundAll,
  type CompoundAllEvent, type CompoundAllRow, type CompoundAllRowInput, type CompoundAllState, type RowFailure, type RowStage,
} from "./state";

/**
 * Drives the compound-all state machine, strictly one row at a time: a row is prepared only when it is its turn (never
 * ahead), signed, and confirmed on Solana before the next row is prepared. A failure, and every `checkpointEvery`
 * finished rows, pause the run until the user answers. The per-row send and the cleanup batch are injected: the real
 * ones are the existing per-position compound flows (`compound-all-executors.ts`), so this file never builds, signs
 * or sends anything itself.
 */
export type RowOutcome =
  | { status: "done"; signature: string }
  | { status: RowFailure; error: string; retryable: boolean; notSigned?: boolean; outcomeUnconfirmed?: boolean; couldntSend?: boolean };
export type CleanupOutcome = { status: "done"; signatures?: readonly string[] } | { status: "failed"; error: string; outcomeUnconfirmed?: boolean; reason?: CleanupFailureReason };

export type RowContext = {
  /** False once the user cancelled: the row stops before the wallet is asked (a prompt already open is answered first). */
  isCurrent: () => boolean;
  onStage: (stage: RowStage, signature?: string) => void;
};
export type CompoundAllDeps = {
  runRow: (row: CompoundAllRow, context: RowContext) => Promise<RowOutcome>;
  /** The existing cleanup batch over the harvest accounts of this run's confirmed Raydium compounds. */
  runCleanup: (sources: readonly string[], context: { onStage: (stage: RowStage) => void }) => Promise<CleanupOutcome>;
};

const message = (error: unknown) => error instanceof Error && error.message ? error.message : "The transaction did not complete.";

export function createCompoundAllRunner(inputs: readonly CompoundAllRowInput[], deps: CompoundAllDeps, options: { checkpointEvery?: number } = {}) {
  let state: CompoundAllState = createCompoundAllState(inputs, options.checkpointEvery);
  const listeners = new Set<(state: CompoundAllState) => void>();
  let wake: (() => void) | null = null;
  let loop: Promise<CompoundAllState> | null = null;

  const dispatch = (event: CompoundAllEvent) => {
    const next = compoundAllReducer(state, event);
    if (next === state) return false;
    state = next;
    for (const listener of listeners) listener(state);
    const waiting = wake; wake = null; waiting?.();
    return true;
  };
  const decision = () => new Promise<void>((resolve) => { wake = resolve; });

  async function runRow(row: CompoundAllRow) {
    const key = row.key;
    dispatch({ type: "row/stage", key, stage: "preparing" });
    let outcome: RowOutcome;
    try {
      outcome = await deps.runRow(rowOfState(key), {
        isCurrent: () => !state.cancelRequested && state.active === key,
        onStage: (stage, signature) => { dispatch({ type: "row/stage", key, stage, ...(signature ? { signature } : {}) }); },
      });
    } catch (error) {
      // An executor should resolve every outcome; an unexpected throw may follow a send, so no automatic retry.
      outcome = { status: "failed", error: message(error), retryable: false };
    }
    if (outcome.status === "done") dispatch({ type: "row/done", key, signature: outcome.signature });
    else dispatch({ type: "row/failed", key, failure: outcome.status, error: outcome.error, retryable: outcome.retryable, notSigned: outcome.notSigned,
      outcomeUnconfirmed: outcome.outcomeUnconfirmed, couldntSend: outcome.couldntSend });
  }
  const rowOfState = (key: string) => state.rows.find((row) => row.key === key)!;

  async function runCleanup() {
    dispatch({ type: "cleanup/stage", stage: "preparing" });
    let outcome: CleanupOutcome;
    try {
      outcome = await deps.runCleanup(state.cleanup.sources, { onStage: (stage) => { dispatch({ type: "cleanup/stage", stage }); } });
    } catch (error) {
      outcome = { status: "failed", error: message(error) };
    }
    if (outcome.status === "done") dispatch({ type: "cleanup/done", signatures: outcome.signatures });
    else dispatch({ type: "cleanup/failed", error: outcome.error, outcomeUnconfirmed: outcome.outcomeUnconfirmed, reason: outcome.reason });
  }

  async function drive(): Promise<CompoundAllState> {
    for (;;) {
      if (state.phase === "finished" || state.phase === "cancelled") return state;
      if (state.phase !== "running") { await decision(); continue; }
      if (state.rowsComplete) {
        if (state.cleanup.status === "pending") { await runCleanup(); continue; }
        await decision(); continue;
      }
      const next = nextQueuedRow(state);
      if (!next) { dispatch({ type: "rows/complete" }); continue; }
      if (dispatch({ type: "checkpoint" })) continue;
      await runRow(next);
    }
  }

  return {
    get state() { return state; },
    subscribe(listener: (state: CompoundAllState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    approvals: () => compoundAllApprovals(state),
    summary: () => summarizeCompoundAll(state),
    select: (key: CompoundAllRow["key"], selected: boolean) => dispatch({ type: "select", key, selected }),
    /** Starts the run once; resolves with the final state (finished or cancelled). */
    start() {
      if (loop) return loop;
      if (!dispatch({ type: "start" })) return Promise.resolve(state);
      loop = drive();
      return loop;
    },
    retry: () => dispatch({ type: "row/retry" }),
    skip: () => dispatch({ type: "row/skip" }),
    continue: () => dispatch({ type: "continue" }),
    cancel: () => dispatch({ type: "cancel" }),
    runCleanup: () => dispatch({ type: "cleanup/run" }),
    skipCleanup: () => dispatch({ type: "cleanup/skip" }),
  };
}
export type CompoundAllRunner = ReturnType<typeof createCompoundAllRunner>;
