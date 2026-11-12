"use client";

import { useCallback, type Dispatch, type MutableRefObject, type RefObject } from "react";
import { clearsSubmitError, mayStartAnotherAttempt, type AtomicStatus } from "@/lib/attempt-status";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import type { CompoundAttempt, CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState } from "@sofinance/engine/compound-types";
import type { CompoundConfirmation } from "./use-compound-attempt";
import {
  confirmedStateFor, type CompoundControllerAction, type CompoundSubmitFeedback,
} from "./compound-controller-state";

type Options = {
  wallet?: string;
  attempt: CompoundAttempt | null;
  attemptStatus: AtomicStatus | null;
  chainStatus: CompoundChainStatus | null;
  dispatch: Dispatch<CompoundControllerAction>;
  identityRef: RefObject<string>;
  resolvedAttemptRef: MutableRefObject<{ signature: string; status: AtomicStatus; chainStatus?: CompoundChainStatus } | null>;
  keepSubmitErrorRef: MutableRefObject<boolean>;
  adoptStateRef: RefObject<(state: CompoundPositionState) => void>;
  refreshStateRef: RefObject<() => void | Promise<void>>;
  onConfirmedRef: RefObject<(() => void) | undefined>;
};

export function useCompoundConfirmation({
  wallet, attempt, attemptStatus, chainStatus, dispatch, identityRef, resolvedAttemptRef, keepSubmitErrorRef,
  adoptStateRef, refreshStateRef, onConfirmedRef,
}: Options) {
  const updateFeedback = useCallback((signature: string, next: Omit<CompoundSubmitFeedback, "signature">) => {
    dispatch({ type: "feedback/update", signature, next });
  }, [dispatch]);
  const onReceipts = useCallback((receipts: CompoundReceipt[]) => {
    dispatch({ type: "receipts/set", receipts });
  }, [dispatch]);
  const onObservation = useCallback((current: CompoundAttempt, checked: CompoundConfirmation) => {
    // The chain result belongs to the stored attempt, regardless of the currently selected NFT.
    resolvedAttemptRef.current = { signature: current.signature, status: checked.status, chainStatus: checked.chainStatus };
    dispatch({
      type: "confirmation/observed", status: checked.status, confirmation: checked, chainStatus: checked.chainStatus ?? null,
    });
    if (checked.status === "success" || checked.status === "failed" || checked.status === "expired") {
      if (clearsSubmitError(checked.status)) {
        keepSubmitErrorRef.current = false;
        dispatch({ type: "confirmation/clear-submit-error", identity: `${current.wallet}:${current.positionMint}`, signature: current.signature });
      }
    }
  }, [dispatch, keepSubmitErrorRef, resolvedAttemptRef]);
  const onTerminal = useCallback((current: CompoundAttempt, checked: CompoundConfirmation, executed: boolean) => {
    // The simulation describes the yield before this transaction. Once it executes,
    // show the refreshed balance even while the follow-up cleanup awaits a signature.
    if (executed && current.kind === "compound" && identityRef.current === `${current.wallet}:${current.positionMint}`) {
      dispatch({ type: "confirmation/clear-preview" });
    }
    if (checked.status === "success" && current.kind === "recovery") {
      dispatch({ type: "confirmation/recovery-progress" });
    }
    if (current.kind === "compound") {
      if (executed) updateFeedback(current.signature, { phase: "success", message: "" });
      else updateFeedback(current.signature, { phase: "failed", message: checked.status === "expired"
        ? "The transaction did not land before it expired. No fees were moved; you can try again."
        : "The transaction reached the chain but failed. Check it on Solscan before trying again." });
    }
    if (executed) notifyPositionHistoryChange(current.positionMint, current.kind === "compound" ? current.signature : undefined);
    const fresh = confirmedStateFor(checked, identityRef.current);
    if (fresh) adoptStateRef.current(fresh); else void refreshStateRef.current();
    onConfirmedRef.current?.();
  }, [adoptStateRef, dispatch, identityRef, onConfirmedRef, refreshStateRef, updateFeedback]);
  const onReadFailure = useCallback((current: CompoundAttempt, message: string) => {
    // Keep the chain observation, but revoke recovery admission until its local cleanup is verified.
    if (current.kind === "recovery" && resolvedAttemptRef.current?.signature === current.signature) {
      resolvedAttemptRef.current = null;
    }
    dispatch({
      type: "confirmation/read-failed", message, identity: `${current.wallet}:${current.positionMint}`, signature: current.signature,
    });
  }, [dispatch, resolvedAttemptRef]);
  const onSlow = useCallback(() => dispatch({ type: "confirmation/slow" }), [dispatch]);
  const chainSettled = chainStatus === "success" || chainStatus === "failed" || chainStatus === "expired";
  const transactionUnresolved = !!attempt && attempt.wallet === wallet && (!chainSettled || attemptStatus === "pending") && !mayStartAnotherAttempt(attemptStatus);
  return { onObservation, onReceipts, onTerminal, onReadFailure, onSlow, transactionUnresolved };
}
