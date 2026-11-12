import type { AtomicStatus } from "@/lib/attempt-status";
import type { CompoundAttempt, CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState, CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundConfirmation } from "./use-compound-attempt";

export type CompoundSubmitFeedback = { phase: "submitting" | "confirming" | "success" | "failed"; signature: string; message: string };
export type CompoundStage = "preparing" | "wallet" | "checking" | "broadcasting" | null;
export type CompoundErrorState = { message: string; identity: string | null; signature: string | null; receiptSignature: string | null };
export type CompoundScanState = {
  started: boolean; scanning: boolean; cursor: string | null; scanned: number; total: number; incomplete: boolean; error: string;
};
export type CompoundCleanupProgress = {
  completed: number; total: number; running: boolean; message: string; compoundSignature?: string;
};

export const emptyCompoundError: CompoundErrorState = { message: "", identity: null, signature: null, receiptSignature: null };
export const emptyCompoundScan: CompoundScanState = {
  started: false, scanning: false, cursor: null, scanned: 0, total: 0, incomplete: false, error: "",
};

export type CompoundControllerState = {
  preview: CompoundSummary | null;
  attempt: CompoundAttempt | null;
  attemptStatus: AtomicStatus | null;
  chainStatus: CompoundChainStatus | null;
  confirmationSlow: boolean;
  confirmation: CompoundConfirmation | null;
  receipts: CompoundReceipt[];
  loadedWallet: string | null;
  storageInvalid: boolean;
  importing: boolean;
  scan: CompoundScanState;
  cleanup: CompoundCleanupProgress | null;
  error: CompoundErrorState;
  stage: CompoundStage;
  feedback: CompoundSubmitFeedback | null;
};

export const initialCompoundControllerState: CompoundControllerState = {
  preview: null,
  attempt: null,
  attemptStatus: null,
  chainStatus: null,
  confirmationSlow: false,
  confirmation: null,
  receipts: [],
  loadedWallet: null,
  storageInvalid: false,
  importing: false,
  scan: emptyCompoundScan,
  cleanup: null,
  error: emptyCompoundError,
  stage: null,
  feedback: null,
};

export type CompoundControllerAction =
  | { type: "operation/clear-stage-cleanup" }
  | { type: "wallet/reset-session" }
  | { type: "wallet/cleared" }
  | {
      type: "wallet/loaded";
      wallet: string;
      attempt: CompoundAttempt | null;
      receipts: CompoundReceipt[];
      invalid: boolean;
    }
  | { type: "wallet/load-failed"; wallet: string }
  | { type: "error/set"; error: CompoundErrorState }
  | { type: "error/clear"; identity: string; signature: string | null }
  | { type: "feedback/update"; signature: string; next: Omit<CompoundSubmitFeedback, "signature"> }
  | { type: "feedback/set"; feedback: CompoundSubmitFeedback | null }
  | { type: "confirmation/observed"; status: AtomicStatus; confirmation: CompoundConfirmation; chainStatus: CompoundChainStatus | null }
  | { type: "confirmation/clear-submit-error"; identity: string; signature: string }
  | { type: "confirmation/clear-preview" }
  | { type: "confirmation/recovery-progress" }
  | { type: "confirmation/read-failed"; message: string; identity: string; signature: string }
  | { type: "confirmation/slow" }
  | { type: "receipts/set"; receipts: CompoundReceipt[] }
  | { type: "preview/set"; preview: CompoundSummary | null }
  | { type: "stage/set"; stage: CompoundStage }
  | { type: "submit/prepare" }
  | {
      type: "submit/persisted";
      attempt: CompoundAttempt;
      receipts: CompoundReceipt[];
      /** Omitted for recovery so an existing compound dialog is left untouched. */
      feedback?: CompoundSubmitFeedback;
    }
  | { type: "submit/abandoned"; receipts: CompoundReceipt[] }
  | { type: "cleanup/set"; cleanup: CompoundCleanupProgress | null }
  | { type: "cleanup/patch"; updater: (previous: CompoundCleanupProgress | null) => CompoundCleanupProgress | null }
  | { type: "scan/set"; scan: CompoundScanState }
  | { type: "scan/patch"; updater: (previous: CompoundScanState) => CompoundScanState }
  | { type: "importing/set"; importing: boolean };

const WALLET_LOAD_ERROR =
  "Local compound history cannot be verified. Check the original transaction and balance accounts before repeating an earlier operation.";
const WALLET_READ_ERROR =
  "Unable to read local compound history. Check previous signatures before repeating an earlier operation.";

export function compoundControllerReducer(
  state: CompoundControllerState, action: CompoundControllerAction,
): CompoundControllerState {
  switch (action.type) {
    case "operation/clear-stage-cleanup":
      return { ...state, stage: null, cleanup: null };
    case "wallet/reset-session":
      return {
        ...state,
        stage: null,
        scan: emptyCompoundScan,
        cleanup: null,
        preview: null,
        confirmation: null,
        chainStatus: null,
        confirmationSlow: false,
        error: emptyCompoundError,
        feedback: null,
      };
    case "wallet/cleared":
      return {
        ...state,
        attempt: null,
        attemptStatus: null,
        receipts: [],
        loadedWallet: null,
        storageInvalid: false,
      };
    case "wallet/loaded":
      return {
        ...state,
        attempt: action.attempt,
        receipts: action.receipts,
        storageInvalid: action.invalid,
        attemptStatus: action.invalid ? "manual-review" : action.attempt ? "pending" : null,
        error: action.invalid ? { message: WALLET_LOAD_ERROR, identity: null, signature: null, receiptSignature: null } : emptyCompoundError,
        loadedWallet: action.wallet,
      };
    case "wallet/load-failed":
      return {
        ...state,
        attempt: null,
        attemptStatus: "manual-review",
        receipts: [],
        loadedWallet: action.wallet,
        storageInvalid: true,
        error: { message: WALLET_READ_ERROR, identity: null, signature: null, receiptSignature: null },
      };
    case "error/set":
      return { ...state, error: action.error };
    case "error/clear":
      return state.error.identity === action.identity && state.error.signature === action.signature
        ? { ...state, error: emptyCompoundError } : state;
    case "feedback/update":
      return state.feedback?.signature === action.signature
        ? { ...state, feedback: { ...action.next, signature: action.signature } } : state;
    case "feedback/set":
      return { ...state, feedback: action.feedback };
    case "confirmation/observed":
      return { ...state, attemptStatus: action.status, confirmation: action.confirmation, chainStatus: action.chainStatus };
    case "confirmation/clear-submit-error":
      return state.error.identity === action.identity && state.error.signature === action.signature
        ? { ...state, error: emptyCompoundError } : state;
    case "confirmation/clear-preview":
      return { ...state, preview: null };
    case "confirmation/recovery-progress":
      return {
        ...state,
        cleanup: state.cleanup && !state.cleanup.running
          ? {
              ...state.cleanup,
              completed: Math.min(state.cleanup.total, state.cleanup.completed + 1),
              message: "Balance merged and account rent recovered. The saved transaction is confirmed on-chain.",
            }
          : state.cleanup,
      };
    case "confirmation/read-failed":
      return {
        ...state,
        attemptStatus: "pending",
        error: action.message
          ? { message: action.message, identity: action.identity, signature: action.signature, receiptSignature: null }
          : emptyCompoundError,
      };
    case "confirmation/slow":
      return { ...state, confirmationSlow: true };
    case "receipts/set":
      return { ...state, receipts: action.receipts };
    case "preview/set":
      return { ...state, preview: action.preview };
    case "stage/set":
      return { ...state, stage: action.stage };
    case "submit/prepare":
      return { ...state, stage: "preparing", error: emptyCompoundError, confirmation: null };
    case "submit/persisted":
      return {
        ...state,
        attempt: action.attempt,
        attemptStatus: "pending",
        chainStatus: "pending",
        confirmationSlow: false,
        receipts: action.receipts,
        stage: "broadcasting",
        feedback: action.feedback !== undefined ? action.feedback : state.feedback,
      };
    case "submit/abandoned":
      return {
        ...state,
        attempt: null,
        attemptStatus: null,
        confirmation: null,
        chainStatus: null,
        confirmationSlow: false,
        receipts: action.receipts,
      };
    case "cleanup/set":
      return { ...state, cleanup: action.cleanup };
    case "cleanup/patch": {
      const cleanup = action.updater(state.cleanup);
      return cleanup === state.cleanup ? state : { ...state, cleanup };
    }
    case "scan/set":
      return { ...state, scan: action.scan };
    case "scan/patch": {
      const scan = action.updater(state.scan);
      return scan === state.scan ? state : { ...state, scan };
    }
    case "importing/set":
      return { ...state, importing: action.importing };
    default: {
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}

/** The fresh position read a finalized compound confirmation carries, when it is for the selection on screen. */
export function confirmedStateFor(confirmation: Pick<CompoundConfirmation, "state">, identity: string): CompoundPositionState | null {
  const state = confirmation.state;
  return state && `${state.wallet}:${state.positionMint}` === identity ? state : null;
}
