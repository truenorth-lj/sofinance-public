import type { DexDescriptor, DexId } from "@/lib/dex/types";
import type { PositionKey } from "@/lib/unified-positions/model";

/**
 * Compound all (LJ 11/26, PM-approved plan): one checklist of every position's compound, signed strictly one after the
 * other. This file is the pure state machine (no React, no network): rows, the run phase, the final Raydium cleanup
 * row and the end-of-run summary. `runner.ts` drives it; the transactions themselves are the existing per-position
 * compound flows, unchanged.
 */

/**
 * Which existing compound flow a row uses, read from the DEX registry (never from the DEX id):
 * - "registry": the generic `dexTxAdapter("compound")` (claim + add, no swap; Meteora today). Out of range, the add
 *   takes only the token the range can hold, so part of the fees go to the wallet.
 * - "native-harvest": the native compound transport (`/api/compound-prepare`, Raydium today). Each compound leaves
 *   harvest accounts that the one final cleanup row closes with the existing cleanup batch.
 */
export type CompoundAllFlow = "registry" | "native-harvest";

/** The flow a DEX's positions compound through, or null when compound all can't run it (no compound, or not Solana). */
export function compoundAllFlowFor(descriptor: Pick<DexDescriptor, "capabilities" | "nativeCapabilities"> | null | undefined): CompoundAllFlow | null {
  if (!descriptor || descriptor.capabilities.signer !== "solana-wallet") return null;
  if (descriptor.capabilities.compound.supported) return "registry";
  if (descriptor.nativeCapabilities?.positions.compound.supported) return "native-harvest";
  return null;
}

/** One position with something to compound. `outOfRange` only matters for the registry flow (part of the fees go to the wallet). */
export type CompoundAllRowInput = { key: PositionKey; dex: DexId; flow: CompoundAllFlow; positionId: string; outOfRange?: boolean };

export type RowFailure = "rejected" | "expired" | "failed";
export type RowStage = "preparing" | "awaiting-wallet" | "confirming";
export type RowStatus = "queued" | RowStage | "done" | RowFailure | "skipped" | "not-signed";
export type CompoundAllRow = Readonly<{
  key: PositionKey; dex: DexId; flow: CompoundAllFlow; positionId: string;
  /** Registry flow out of range (Meteora): only one token's fees go back into the position, the rest go to the wallet. */
  partToWallet: boolean;
  selected: boolean; status: RowStatus;
  /** Prepares so far (a retry prepares a fresh transaction). */
  attempts: number;
  signature?: string; error?: string;
  /** A failed row may be retried (false when the last send may still land). */
  retryable?: boolean;
  /** The last send may still land: Skip only, and the pause must not say it didn't compound. */
  outcomeUnconfirmed?: boolean;
  /** A non-explicit wallet cancel whose send may still land: the row says "Couldn't send", not "Rejected in wallet". */
  couldntSend?: boolean;
}>;

export type CleanupStatus = "none" | "pending" | "offered" | RowStage | "done" | "failed" | "skipped";
export type CompoundAllCleanup = Readonly<{
  status: CleanupStatus;
  /** Signatures of the Raydium compounds confirmed in this run: their harvest accounts are what the cleanup closes. */
  sources: readonly string[];
  error?: string; signatures?: readonly string[];
  /** Confirm timed out or needs review: the cleanup may still settle; the row says Unconfirmed, not Failed. */
  outcomeUnconfirmed?: boolean;
}>;

/**
 * setup → running → (paused-failure | paused-checkpoint)* → cleanup (automatic when rows finish, offered after a cancel)
 * → finished | cancelled. `cancelling` = cancel was asked while a row was in flight: the run stops after that row.
 */
export type CompoundAllPhase = "setup" | "running" | "paused-failure" | "paused-checkpoint" | "cleanup-offered" | "paused-cleanup-failure"
  | "finished" | "cancelled";

export type CompoundAllState = Readonly<{
  phase: CompoundAllPhase;
  rows: readonly CompoundAllRow[];
  cleanup: CompoundAllCleanup;
  /** The row being prepared, signed or confirmed (or the failed row a pause is about). */
  active: PositionKey | null;
  /** Rows finished (done or skipped) since the start or the last Continue; the run pauses at `checkpointEvery`. */
  sinceCheckpoint: number;
  checkpointEvery: number;
  cancelRequested: boolean;
  /** Every selected row has finished, been skipped, or was left unsigned by a cancel. */
  rowsComplete: boolean;
  cancelled: boolean;
}>;

export type CompoundAllEvent =
  | { type: "select"; key: PositionKey; selected: boolean }
  | { type: "start" }
  | { type: "row/stage"; key: PositionKey; stage: RowStage; signature?: string }
  | { type: "row/done"; key: PositionKey; signature: string }
  | { type: "row/failed"; key: PositionKey; failure: RowFailure; error: string; retryable: boolean; notSigned?: boolean;
      outcomeUnconfirmed?: boolean; couldntSend?: boolean }
  | { type: "row/retry" }
  | { type: "row/skip" }
  | { type: "checkpoint" }
  | { type: "continue" }
  | { type: "cancel" }
  | { type: "rows/complete" }
  | { type: "cleanup/run" }
  | { type: "cleanup/skip" }
  | { type: "cleanup/stage"; stage: RowStage }
  | { type: "cleanup/done"; signatures?: readonly string[] }
  | { type: "cleanup/failed"; error: string; outcomeUnconfirmed?: boolean };

export const COMPOUND_ALL_CHECKPOINT_EVERY = 10;
export const COMPOUND_ALL_RECOVERY_PATH = "/app/portfolio/recovery";

const IN_FLIGHT: readonly string[] = ["preparing", "awaiting-wallet", "confirming"] satisfies RowStage[];
const FAILURES: readonly RowStatus[] = ["rejected", "expired", "failed"];

/** The checklist before Start: Meteora rows out of range start unselected, every other row selected. */
export function createCompoundAllState(inputs: readonly CompoundAllRowInput[], checkpointEvery = COMPOUND_ALL_CHECKPOINT_EVERY): CompoundAllState {
  if (!Number.isInteger(checkpointEvery) || checkpointEvery < 1) throw new Error("checkpointEvery must be a positive integer");
  const seen = new Set<string>();
  const rows = inputs.map((input): CompoundAllRow => {
    if (seen.has(input.key)) throw new Error(`Duplicate compound-all row ${input.key}`);
    seen.add(input.key);
    const partToWallet = input.flow === "registry" && input.outOfRange === true;
    return Object.freeze({ key: input.key, dex: input.dex, flow: input.flow, positionId: input.positionId, partToWallet, selected: !partToWallet, status: "queued", attempts: 0 });
  });
  return Object.freeze({ phase: "setup", rows: Object.freeze(rows), cleanup: Object.freeze({ status: "none", sources: Object.freeze([]) }), active: null,
    sinceCheckpoint: 0, checkpointEvery, cancelRequested: false, rowsComplete: false, cancelled: false });
}

/** Wallet approvals Start will ask for: one per selected row, plus one for the final Raydium cleanup batch. */
export function compoundAllApprovals(state: Pick<CompoundAllState, "rows">) {
  const selected = state.rows.filter((row) => row.selected);
  const rows = selected.length;
  const cleanup = selected.some((row) => row.flow === "native-harvest") ? 1 : 0;
  return { rows, cleanup, total: rows + cleanup };
}

/** The next selected row waiting to be prepared, if any. */
export function nextQueuedRow(state: CompoundAllState) {
  return state.rows.find((row) => row.selected && row.status === "queued") ?? null;
}

export type CompoundAllSummary = {
  selected: number; done: number; skipped: number; notSigned: number; failed: number; notSelected: number;
  signatures: string[];
  cleanup: CleanupStatus;
  /** Raydium harvest accounts from this run may still hold balances: the recovery page can return them. */
  recoveryPath: string | null;
};

export function summarizeCompoundAll(state: CompoundAllState): CompoundAllSummary {
  const selected = state.rows.filter((row) => row.selected);
  const count = (statuses: readonly RowStatus[]) => selected.filter((row) => statuses.includes(row.status)).length;
  return {
    selected: selected.length, done: count(["done"]), skipped: count(["skipped"]), notSigned: count(["not-signed", "queued"]),
    failed: count(FAILURES), notSelected: state.rows.length - selected.length,
    signatures: selected.flatMap((row) => row.status === "done" && row.signature ? [row.signature] : []),
    cleanup: state.cleanup.status,
    recoveryPath: state.cleanup.sources.length > 0 && state.cleanup.status !== "done" ? COMPOUND_ALL_RECOVERY_PATH : null,
  };
}

function patchRow(state: CompoundAllState, key: PositionKey, patch: Partial<CompoundAllRow>): CompoundAllState {
  return { ...state, rows: Object.freeze(state.rows.map((row) => row.key === key ? Object.freeze({ ...row, ...patch }) : row)) };
}
const rowOf = (state: CompoundAllState, key: PositionKey | null) => key === null ? undefined : state.rows.find((row) => row.key === key);

/** Stop for good: rows not started stay unsigned; the cleanup row is offered for Raydium rows already done. */
function stopRows(state: CompoundAllState): CompoundAllState {
  const rows = Object.freeze(state.rows.map((row) => row.selected && row.status === "queued" ? Object.freeze({ ...row, status: "not-signed" as const }) : row));
  const offered = state.cleanup.sources.length > 0 && state.cleanup.status === "pending";
  return { ...state, rows, active: null, cancelRequested: false, rowsComplete: true, cancelled: true,
    phase: offered ? "cleanup-offered" : "cancelled", cleanup: offered ? Object.freeze({ ...state.cleanup, status: "offered" as const }) : state.cleanup };
}
const ended = (state: CompoundAllState): CompoundAllPhase => state.cancelled ? "cancelled" : "finished";

/** Pure transition; an event that does not apply to the current phase returns the same state object. */
export function compoundAllReducer(state: CompoundAllState, event: CompoundAllEvent): CompoundAllState {
  switch (event.type) {
    case "select": {
      const row = rowOf(state, event.key);
      if (state.phase !== "setup" || !row || row.selected === event.selected) return state;
      return patchRow(state, event.key, { selected: event.selected });
    }
    case "start":
      if (state.phase !== "setup" || !state.rows.some((row) => row.selected)) return state;
      return { ...state, phase: "running" };
    case "row/stage": {
      const row = rowOf(state, event.key);
      if (state.phase !== "running" || !row || !row.selected || !(row.status === "queued" || IN_FLIGHT.includes(row.status))) return state;
      if (state.active !== null && state.active !== event.key) return state;
      return { ...patchRow(state, event.key, {
        // A queued row starts a fresh attempt: the previous attempt's error and signature are cleared.
        ...(row.status === "queued" ? { attempts: row.attempts + 1, error: undefined, retryable: undefined, signature: undefined,
          outcomeUnconfirmed: undefined, couldntSend: undefined } : {}),
        status: event.stage, ...(event.signature ? { signature: event.signature } : {}),
      }), active: event.key };
    }
    case "row/done": {
      const row = rowOf(state, event.key);
      if (state.phase !== "running" || state.active !== event.key || !row || !IN_FLIGHT.includes(row.status)) return state;
      const raydium = row.flow === "native-harvest";
      const cleanup = raydium ? Object.freeze({ ...state.cleanup, sources: Object.freeze([...state.cleanup.sources, event.signature]),
        status: state.cleanup.status === "none" ? "pending" as const : state.cleanup.status }) : state.cleanup;
      const next: CompoundAllState = { ...patchRow(state, event.key, { status: "done", signature: event.signature, error: undefined }),
        cleanup, active: null, sinceCheckpoint: state.sinceCheckpoint + 1 };
      return state.cancelRequested ? stopRows(next) : next;
    }
    case "row/failed": {
      const row = rowOf(state, event.key);
      if (state.phase !== "running" || state.active !== event.key || !row || !IN_FLIGHT.includes(row.status)) return state;
      if (state.cancelRequested) {
        const status: RowStatus = event.notSigned ? "not-signed" : event.failure;
        return stopRows(patchRow(state, event.key, { status, error: event.error, retryable: false,
          outcomeUnconfirmed: event.outcomeUnconfirmed, couldntSend: event.couldntSend }));
      }
      return { ...patchRow(state, event.key, { status: event.failure, error: event.error, retryable: event.retryable,
        outcomeUnconfirmed: event.outcomeUnconfirmed, couldntSend: event.couldntSend }), phase: "paused-failure" };
    }
    case "row/retry": {
      const row = rowOf(state, state.active);
      if (state.phase !== "paused-failure" || !row || !row.retryable) return state;
      return { ...patchRow(state, row.key, { status: "queued" }), phase: "running", active: null };
    }
    case "row/skip": {
      const row = rowOf(state, state.active);
      if (state.phase !== "paused-failure" || !row) return state;
      return { ...patchRow(state, row.key, { status: "skipped", retryable: false }), phase: "running", active: null, sinceCheckpoint: state.sinceCheckpoint + 1 };
    }
    case "checkpoint":
      if (state.phase !== "running" || state.active !== null || state.cancelRequested || state.sinceCheckpoint < state.checkpointEvery || !nextQueuedRow(state)) return state;
      return { ...state, phase: "paused-checkpoint" };
    case "continue":
      if (state.phase !== "paused-checkpoint") return state;
      return { ...state, phase: "running", sinceCheckpoint: 0 };
    case "cancel":
      if (state.phase === "setup") return { ...state, phase: "cancelled", cancelled: true, rowsComplete: true };
      if (state.phase === "paused-failure" || state.phase === "paused-checkpoint") return stopRows(state);
      if (state.phase === "paused-cleanup-failure") return { ...state, phase: "cleanup-offered", cancelled: true,
        cleanup: Object.freeze({ ...state.cleanup, status: "offered" as const }) };
      if (state.phase === "running" && state.rowsComplete && state.cleanup.status === "pending") return { ...state, phase: "cleanup-offered", cancelled: true,
        cleanup: Object.freeze({ ...state.cleanup, status: "offered" as const }) };
      if (state.phase !== "running" || state.rowsComplete) return state;
      if (state.active !== null) return state.cancelRequested ? state : { ...state, cancelRequested: true };
      return stopRows(state);
    case "rows/complete":
      if (state.phase !== "running" || state.active !== null || state.rowsComplete || nextQueuedRow(state)) return state;
      return state.cleanup.status === "pending" ? { ...state, rowsComplete: true } : { ...state, rowsComplete: true, phase: ended(state) };
    case "cleanup/run":
      if (state.phase !== "cleanup-offered" && state.phase !== "paused-cleanup-failure") return state;
      return { ...state, phase: "running", cleanup: Object.freeze({ ...state.cleanup, status: "pending" as const, error: undefined, outcomeUnconfirmed: undefined }) };
    case "cleanup/skip":
      if (state.phase !== "cleanup-offered" && state.phase !== "paused-cleanup-failure") return state;
      return { ...state, phase: ended(state), cleanup: Object.freeze({ ...state.cleanup, status: "skipped" as const }) };
    case "cleanup/stage":
      if (state.phase !== "running" || !state.rowsComplete || !(state.cleanup.status === "pending" || IN_FLIGHT.includes(state.cleanup.status))) return state;
      return { ...state, cleanup: Object.freeze({ ...state.cleanup, status: event.stage }) };
    case "cleanup/done":
      if (state.phase !== "running" || !IN_FLIGHT.includes(state.cleanup.status)) return state;
      return { ...state, phase: ended(state), cleanup: Object.freeze({ ...state.cleanup, status: "done" as const, error: undefined,
        ...(event.signatures ? { signatures: Object.freeze([...event.signatures]) } : {}) }) };
    case "cleanup/failed":
      if (state.phase !== "running" || !IN_FLIGHT.includes(state.cleanup.status)) return state;
      return { ...state, phase: "paused-cleanup-failure", cleanup: Object.freeze({ ...state.cleanup, status: "failed" as const, error: event.error, outcomeUnconfirmed: event.outcomeUnconfirmed }) };
  }
}
