"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { AtomicStatus } from "@/lib/attempt-status";
import { loadCompoundReceipts, removeConsumedCompoundReceipts, removeRecoveredReceipt, removeUnconfirmedCompoundReceipt,
  type CompoundAttempt, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState } from "@sofinance/engine/compound-types";
import { post } from "./compound-client";

export type CompoundConfirmation = { status: AtomicStatus; signature: string; state: CompoundPositionState | null;
  chainStatus?: CompoundChainStatus;
  receipt?: { harvestedA: string; harvestedB: string; investedA: string; investedB: string;
    remainingA: string; remainingB: string; rewards: { mint: string; amount: string; compounded: boolean }[] };
  transactionError?: unknown };

// These refs remain shared with the facade's synchronous command and wallet-load boundaries.
// A React state update cannot revoke a confirmation before prepare/sign yields.
type ConfirmationOwnership = {
  mounted: RefObject<boolean>;
  wallet: RefObject<string | undefined>;
  signature: RefObject<string | null>;
  request: RefObject<number>;
  recoveryWait: RefObject<{ signature: string } | null>;
  keepSubmitError: RefObject<boolean>;
};
type Options = {
  wallet?: string;
  attempt: CompoundAttempt | null;
  unresolved: boolean;
  ownership: ConfirmationOwnership;
  // Stable, synchronous facade events preserve observation -> receipts -> terminal coordination.
  onObservation: (current: CompoundAttempt, checked: CompoundConfirmation) => void;
  onReceipts: (receipts: CompoundReceipt[]) => void;
  onTerminal: (current: CompoundAttempt, checked: CompoundConfirmation, executed: boolean) => void;
  onReadFailure: (current: CompoundAttempt, message: string) => void;
  onSlow: () => void;
};
const statusValues: AtomicStatus[] = ["pending", "expired", "failed", "success", "manual-review"];
const chainStatusValues: CompoundChainStatus[] = ["pending", "expired", "failed", "success", "unknown"];
const slowConfirmationMs = 30_000;
class CompoundVerificationError extends Error {}

/** P4a1: confirmation protocol, receipt pruning and polling. History/command state stays in the facade. */
export function useCompoundAttempt({ wallet, attempt, unresolved, ownership,
  onObservation, onReceipts, onTerminal, onReadFailure, onSlow }: Options) {
  const { mounted: mountedRef, wallet: walletRef, signature: signatureRef, request: requestRef,
    recoveryWait: recoveryWaitRef, keepSubmitError: keepSubmitErrorRef } = ownership;
  const previousTerminal = useRef<string | null>(null);
  // Only background polling is deduplicated; explicit rechecks retain request-order ownership.
  const reconcileInFlight = useRef<string | null>(null);
  const reconcile = useCallback(async (current: CompoundAttempt, signal?: AbortSignal) => {
    const requestId = ++requestRef.current;
    try {
      const checked = await post<CompoundConfirmation>("/api/compound-confirm", { wallet: current.wallet, attempt: current }, signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
      if (!mountedRef.current || walletRef.current !== current.wallet || signatureRef.current !== current.signature || requestId !== requestRef.current) return null;
      if (checked.signature !== current.signature || !statusValues.includes(checked.status) ||
        checked.chainStatus !== undefined && !chainStatusValues.includes(checked.chainStatus)) throw new CompoundVerificationError("Transaction verification returned signature or status mismatch");
      onObservation(current, checked);
      if (checked.status === "success" || checked.status === "failed" || checked.status === "expired") {
        if ((checked.status === "failed" || checked.status === "expired") && current.kind === "compound") {
          removeUnconfirmedCompoundReceipt(window.localStorage, current);
          onReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
        }
        if (checked.status === "success" && current.kind === "recovery") {
          removeRecoveredReceipt(window.localStorage, current);
          onReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
        }
        if (checked.status === "success" && current.kind === "compound") {
          removeConsumedCompoundReceipts(window.localStorage, current);
          onReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
        }
      }
      const executed = checked.chainStatus === "success" || checked.status === "success";
      if (executed || checked.status === "failed" || checked.status === "expired") {
        const terminal = `${current.signature}:${checked.chainStatus ?? checked.status}:${checked.status}`;
        if (previousTerminal.current !== terminal) {
          previousTerminal.current = terminal;
          onTerminal(current, checked, executed);
        }
      }
      return checked;
    } catch (caught) {
      if (mountedRef.current && walletRef.current === current.wallet && signatureRef.current === current.signature &&
        requestId === requestRef.current && !keepSubmitErrorRef.current && !signal?.aborted) {
        // A read timeout says nothing about execution. Keep polling the same signature.
        onReadFailure(current, caught instanceof CompoundVerificationError ? caught.message : "");
      }
    }
  }, [requestRef, mountedRef, walletRef, signatureRef, keepSubmitErrorRef, onObservation, onReceipts, onTerminal, onReadFailure]);

  useEffect(() => {
    if (!attempt || !unresolved) return;
    let cancelled = false;
    const run = () => {
      if (reconcileInFlight.current === attempt.signature || cancelled || recoveryWaitRef.current?.signature === attempt.signature ||
        signatureRef.current !== attempt.signature) return;
      reconcileInFlight.current = attempt.signature;
      void reconcile(attempt).finally(() => { if (reconcileInFlight.current === attempt.signature) reconcileInFlight.current = null; });
    };
    const initial = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 4_000);
    // Thirty seconds changes historical feedback and triggers a read-only recheck.
    const slow = window.setTimeout(() => { if (signatureRef.current !== attempt.signature) return; onSlow(); run(); },
      Math.max(0, slowConfirmationMs - (Date.now() - attempt.createdAt)));
    return () => { cancelled = true; window.clearTimeout(initial); window.clearInterval(poll); window.clearTimeout(slow); };
  }, [attempt, unresolved, wallet, reconcile, recoveryWaitRef, signatureRef, onSlow]);

  return reconcile;
}
