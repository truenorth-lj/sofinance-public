"use client";

import { useEffect, useLayoutEffect, type Dispatch, type MutableRefObject, type RefObject } from "react";
import type { AtomicStatus } from "@/lib/attempt-status";
import type { CompoundAttempt, CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";
import type { CompoundControllerAction, CompoundStage } from "./compound-controller-state";

type RecoveryOutcome = "success" | "stopped";

type Options = {
  wallet?: string;
  identity: string;
  visibleAttempt: CompoundAttempt | null;
  attemptStatus: AtomicStatus | null;
  chainStatus: CompoundChainStatus | null;
  stage: CompoundStage;
  receipts: CompoundReceipt[];
  externalBlocked: boolean;
  submit: (receipt?: CompoundReceipt, batch?: boolean) => Promise<RecoveryOutcome>;
  dispatch: Dispatch<CompoundControllerAction>;
  mounted: RefObject<boolean>;
  lifecycle: RefObject<number>;
  walletRef: RefObject<string | undefined>;
  identityRef: RefObject<string>;
  connectionRef: RefObject<{ connected: boolean }>;
  externalBlockedRef: RefObject<boolean>;
  cleanupRunningRef: MutableRefObject<boolean>;
  submitting: RefObject<boolean>;
  autoCleanup: MutableRefObject<{ wallet: string; signature: string; identity: string } | null>;
  runRecoveryRef: MutableRefObject<(items: CompoundReceipt[], signature?: string) => Promise<void>>;
  operationLifecycleRef: MutableRefObject<number>;
};

export function useCompoundRecovery({
  wallet, identity, visibleAttempt, attemptStatus, chainStatus, stage, receipts, externalBlocked,
  submit, dispatch, mounted, lifecycle, walletRef, identityRef, connectionRef, externalBlockedRef,
  cleanupRunningRef, submitting, autoCleanup, runRecoveryRef, operationLifecycleRef,
}: Options) {
  async function runRecovery(items: CompoundReceipt[], compoundSignature?: string) {
    if (!wallet || cleanupRunningRef.current || submitting.current || externalBlockedRef.current || !connectionRef.current.connected) return;
    const requestedWallet = wallet;
    const requestedLifecycle = lifecycle.current;
    const current = () => mounted.current && lifecycle.current === requestedLifecycle && walletRef.current === requestedWallet;
    cleanupRunningRef.current = true; operationLifecycleRef.current = lifecycle.current;
    let completed = 0;
    dispatch({ type: "cleanup/set", cleanup: { completed, total: items.length, running: true, message: "Approve each cleanup transaction in your wallet.", compoundSignature } });
    try {
      for (const receipt of items) {
        if (!current() || externalBlockedRef.current) return;
        const outcome = await submit(receipt, true);
        if (!current()) return;
        if (outcome !== "success") {
          dispatch({ type: "cleanup/set", cleanup: { completed, total: items.length, running: false, compoundSignature,
            message: "Cleanup paused. Remaining balances are saved below. Verify the last transaction, then retry cleanup." } });
          return;
        }
        completed++;
        dispatch({ type: "cleanup/set", cleanup: { completed, total: items.length, running: true, compoundSignature, message: "Balance merged and account rent recovered." } });
      }
      if (current()) dispatch({ type: "cleanup/set", cleanup: { completed, total: items.length, running: false, compoundSignature,
        message: "All selected harvest accounts cleaned up. Balances were merged into your wallet and account rent returned." } });
    } catch (caught) {
      if (current()) dispatch({ type: "cleanup/set", cleanup: { completed, total: items.length, running: false, compoundSignature,
        message: caught instanceof Error ? caught.message : "Cleanup paused. Check the last transaction before retrying." } });
    } finally {
      cleanupRunningRef.current = false;
      if (current()) dispatch({ type: "cleanup/patch", updater: (previous) => previous ? { ...previous, running: false } : previous });
    }
  }
  useLayoutEffect(() => { runRecoveryRef.current = runRecovery; });
  useEffect(() => {
    const approved = autoCleanup.current;
    if (!approved || approved.wallet !== wallet || approved.identity !== identity || approved.signature !== visibleAttempt?.signature ||
      visibleAttempt.kind !== "compound" || attemptStatus !== "success" || chainStatus !== null && chainStatus !== "success" || stage !== null || cleanupRunningRef.current) return;
    const receipt = receipts.find(item => item.sourceSignature === approved.signature);
    if (!receipt) return;
    // Keep the approval until the callback actually starts. A receipt refresh
    // may replace this effect and timer without revoking the user's action.
    const timer = window.setTimeout(() => {
      if (!mounted.current || identityRef.current !== approved.identity || autoCleanup.current !== approved ||
        cleanupRunningRef.current || submitting.current || externalBlockedRef.current || !connectionRef.current.connected) return;
      autoCleanup.current = null;
      void runRecoveryRef.current([receipt], approved.signature);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet, identity, visibleAttempt, attemptStatus, chainStatus, stage, receipts, externalBlocked, autoCleanup, cleanupRunningRef, connectionRef, externalBlockedRef, identityRef, mounted, runRecoveryRef, submitting]);

  return { recover: (receipt: CompoundReceipt) => runRecovery([receipt]) };
}
