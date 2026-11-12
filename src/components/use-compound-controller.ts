"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { apiErrorCode, post } from "./transactions/compound/compound-client";
import type { AtomicStatus } from "@/lib/attempt-status";
import { sendAndTrack, TxNotSentError, useCancelCheckPending } from "@/lib/tx-pipeline";
import { ApiRequestError, INSUFFICIENT_SOL_CODE, resolveCompoundBroadcastFailure } from "@/lib/public-error";
import { abandonUnsentCompoundAttempt, compoundAttemptKey, compoundReceiptsKey, loadCompoundAttempt, loadCompoundReceipts, persistCompoundAttempt,
  type CompoundAttempt, type CompoundPrepared, type CompoundReceipt, type RecoveryPrepared } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { useWalletConnection } from "./wallet-connection";
import { useCleanupBatchController } from "./use-cleanup-batch-controller";
import { loadCleanupBatch, cleanupBatchKey } from "@/lib/compound-cleanup-batch-attempt";
import { useCompoundPositionSnapshot } from "./transactions/compound/use-compound-position-snapshot";
import {
  compoundControllerReducer, emptyCompoundScan, initialCompoundControllerState,
  type CompoundSubmitFeedback,
} from "./transactions/compound/compound-controller-state";
import { useCompoundAttempt } from "./transactions/compound/use-compound-attempt";
import { useCompoundConfirmation } from "./transactions/compound/use-compound-confirmation";
import { useCompoundRecovery } from "./transactions/compound/use-compound-recovery";
import { useCleanupScan } from "./transactions/compound/use-cleanup-scan";

export type { CompoundConfirmation } from "./transactions/compound/use-compound-attempt";
export type { CompoundSubmitFeedback };
export { confirmedStateFor } from "./transactions/compound/compound-controller-state";
export { COMPOUND_STATE_RPC_RETRY_DELAYS_MS } from "./transactions/compound/use-compound-position-snapshot";

type Options = { wallet?: string; positionMint?: string; externalBlocked: boolean; onConfirmed?: () => void };
type AlreadyClosedRecovery = { alreadyClosed: true; wallet: string; accounts: string[] };
const CLEANUP_RENT_HINT = "Tip: \u201cClean up all balances\u201d below returns SOL rent held by earlier harvest accounts.";
const recoveryConfirmationMs = 90_000;
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
type RecoveryOutcome = "success" | "stopped";
function recoveryMayProceed(value: { status: AtomicStatus; chainStatus?: CompoundChainStatus } | null) {
  return !!value && ["success", "failed", "expired"].includes(value.status) &&
    (value.chainStatus === undefined || value.chainStatus === value.status);
}

export function useCompoundController({ wallet, positionMint, externalBlocked, onConfirmed }: Options) {
  const connection = useWalletConnection();
  const [controller, dispatch] = useReducer(compoundControllerReducer, initialCompoundControllerState);
  const {
    preview, attempt, attemptStatus, chainStatus, confirmationSlow, confirmation, receipts, loadedWallet,
    storageInvalid, importing, scan, cleanup, error: errorState, stage, feedback,
  } = controller;
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  const operationLifecycle = useRef(0);
  const recoveryWait = useRef<{ signature: string; controller: AbortController } | null>(null);
  const scanRequest = useRef(0);
  const scanRunning = useRef(false);
  const cleanupRunning = useRef(false);
  const autoCleanup = useRef<{ wallet: string; signature: string; identity: string } | null>(null);
  const resolvedAttempt = useRef<{ signature: string; status: AtomicStatus; chainStatus?: CompoundChainStatus } | null>(null);
  const runRecoveryRef = useRef<(items: CompoundReceipt[], signature?: string) => Promise<void>>(async () => {});
  const setError = useCallback((message: string, identity: string | null = null, signature: string | null = null, receiptSignature: string | null = null) =>
    dispatch({ type: "error/set", error: { message, identity, signature, receiptSignature } }), []);
  const clearError = useCallback((identity: string, signature: string | null = null) =>
    dispatch({ type: "error/clear", identity, signature }), []);
  const updateFeedback = useCallback((signature: string, next: Omit<CompoundSubmitFeedback, "signature">) =>
    dispatch({ type: "feedback/update", signature, next }), []);
  const identity = `${wallet || ""}:${positionMint || ""}`;
  const identityRef = useRef(identity);
  const walletRef = useRef(wallet);
  const externalBlockedRef = useRef(externalBlocked);
  const onConfirmedRef = useRef(onConfirmed);
  const connectionRef = useRef(connection);
  const confirmationRequest = useRef(0);
  const submitting = useRef(false);
  const operationRequest = useRef(0);
  const attemptSignatureRef = useRef<string | null>(null);
  const keepSubmitErrorRef = useRef(false);
  // Mirror refs stay on layout effects (not useLatest): submit, recovery, and confirmation
  // read them on the money path, and useLatest would write during render.
  useLayoutEffect(() => {
    if (walletRef.current !== wallet) scanRequest.current++;
    if (identityRef.current !== identity) { lifecycle.current++; autoCleanup.current = null; recoveryWait.current?.controller.abort(); }
    identityRef.current = identity; walletRef.current = wallet;
    externalBlockedRef.current = externalBlocked; onConfirmedRef.current = onConfirmed;
    connectionRef.current = connection;
  }, [identity, wallet, externalBlocked, onConfirmed, connection]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; autoCleanup.current = null; recoveryWait.current?.controller.abort(); };
  }, []);

  useEffect(() => {
    const selectedLifecycle = lifecycle.current;
    const timer = window.setTimeout(() => {
      if (lifecycle.current === selectedLifecycle && operationLifecycle.current !== selectedLifecycle) {
        dispatch({ type: "operation/clear-stage-cleanup" });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      dispatch({ type: "wallet/reset-session" });
      scanRequest.current++; resolvedAttempt.current = null;
      keepSubmitErrorRef.current = false;
      if (!wallet) {
        attemptSignatureRef.current = null;
        dispatch({ type: "wallet/cleared" });
        return;
      }
      try {
        const saved = loadCompoundAttempt(window.localStorage, wallet);
        const savedReceipts = loadCompoundReceipts(window.localStorage, wallet);
        if (cancelled || walletRef.current !== wallet) return;
        attemptSignatureRef.current = saved.attempt?.signature || null;
        dispatch({ type: "wallet/loaded", wallet, attempt: saved.attempt, receipts: savedReceipts.receipts,
          invalid: saved.invalid || savedReceipts.invalid });
      } catch {
        if (!cancelled && walletRef.current === wallet) dispatch({ type: "wallet/load-failed", wallet });
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [wallet]);

  const isSnapshotCurrent = useCallback((requestedIdentity: string) =>
    mounted.current && identityRef.current === requestedIdentity, []);
  const onReadSuccess = useCallback((requestedIdentity: string) => {
    if (!keepSubmitErrorRef.current) clearError(requestedIdentity);
  }, [clearError]);
  const onReadError = useCallback((requestedIdentity: string, message: string) => {
    // Read failures must not replace a prepare/broadcast error, including after expired confirmation.
    if (!keepSubmitErrorRef.current) setError(message, requestedIdentity);
  }, [setError]);
  const { state, loading, refresh: refreshState, adopt: adoptState, invalidate: invalidateState, clear: clearState } =
    useCompoundPositionSnapshot({ wallet, positionMint, isCurrent: isSnapshotCurrent, onReadSuccess, onReadError });
  // Confirmation polling reads the latest readers through refs, so selecting a position does not restart the poll.
  const refreshStateRef = useRef(refreshState);
  const adoptStateRef = useRef(adoptState);
  useLayoutEffect(() => { refreshStateRef.current = refreshState; adoptStateRef.current = adoptState; });
  useEffect(() => {
    invalidateState();
    const timer = window.setTimeout(() => { clearState(); dispatch({ type: "preview/set", preview: null }); void refreshState(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshState, invalidateState, clearState]);

  const onBatchReceipts = useCallback((next: CompoundReceipt[]) => dispatch({ type: "receipts/set", receipts: next }), []);
    const { onObservation, onReceipts, onTerminal, onReadFailure, onSlow, transactionUnresolved } = useCompoundConfirmation({
    wallet, attempt, attemptStatus, chainStatus, dispatch, identityRef, resolvedAttemptRef: resolvedAttempt,
    keepSubmitErrorRef, adoptStateRef, refreshStateRef, onConfirmedRef,
  });
  const reconcile = useCompoundAttempt({
    wallet, attempt, unresolved: transactionUnresolved,
    ownership: { mounted, wallet: walletRef, signature: attemptSignatureRef, request: confirmationRequest, recoveryWait, keepSubmitError: keepSubmitErrorRef },
    onObservation, onReceipts, onTerminal, onReadFailure, onSlow,
  });

  const visibleState = state && state.wallet === wallet && state.positionMint === positionMint ? state : null;
  const visiblePreview = preview && preview.state.wallet === wallet && preview.positionMint === positionMint ? preview : null;
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  const batchCleanup = useCleanupBatchController({ wallet, identity, connection, blocked: externalBlocked || stage !== null || !!cleanup?.running,
    canStart: () => !storageInvalid && !submitting.current && (!attempt || resolvedAttempt.current?.signature === attempt.signature && recoveryMayProceed(resolvedAttempt.current)),
    onReceipts: onBatchReceipts, onConfirmed: () => { void refreshState(); onConfirmedRef.current?.(); } });
  const busy = stage !== null || !!cleanup?.running || batchCleanup.busy;
  const walletBlocked = busy;
  const receiptReviewRequired = chainStatus === "success" && attemptStatus !== "success";
  const priorReceipts = loadedWallet === wallet ? receipts.filter((receipt) => receipt.positionMint === positionMint) : [];
  // Only the currently verified successful receipt may be reused automatically.
  // Older or unresolved accounts remain available through explicit recovery.
  const sourceSignatures = [...new Set(priorReceipts.filter((receipt) =>
    attemptStatus === "success" && receipt.sourceSignature === visibleAttempt?.signature)
    .map((receipt) => receipt.sourceSignature))];
  const hasFees = (visibleState ? BigInt(visibleState.fees.a) > 0n || BigInt(visibleState.fees.b) > 0n ||
    visibleState.rewards.some((reward) => BigInt(reward.estimatedAmount) > 0n) : false) || sourceSignatures.length > 0;
  // A cancelled compound of this position is still being checked on-chain: no second one yet.
  const cancelPending = useCancelCheckPending("compound", positionMint ?? undefined);
  const canCompound = !!wallet && !!positionMint && connection.connected && !cancelPending &&
    !!visibleState?.eligible && hasFees && !externalBlocked && !walletBlocked && !batchCleanup.unresolved && !batchCleanup.invalid;

  async function submit(receipt?: CompoundReceipt, batch = false): Promise<RecoveryOutcome> {
    if (cleanupRunning.current && !batch) return "stopped";
    if (wallet) {
      const savedBatch = loadCleanupBatch(window.localStorage, wallet);
      if (savedBatch.invalid || savedBatch.attempt?.transactions.some(tx => !tx.unsent && !["success", "failed", "expired"].includes(tx.status))) return "stopped";
    }
    if (!wallet || (!receipt && !positionMint) || !connection.connected || submitting.current || externalBlockedRef.current || (walletBlocked && !batch) ||
      (!receipt && !canCompound) || (receipt && receipt.wallet !== wallet)) return "stopped";
    const cleanupBatchRecord = window.localStorage.getItem(cleanupBatchKey(wallet));
    const recoveryAttemptRecord = receipt ? window.localStorage.getItem(compoundAttemptKey(wallet)) : null;
    if (receipt) {
      const saved = loadCompoundAttempt(window.localStorage, wallet);
      if (saved.invalid || saved.attempt && (resolvedAttempt.current?.signature !== saved.attempt.signature ||
        !recoveryMayProceed(resolvedAttempt.current))) {
        dispatch({ type: "cleanup/patch", updater: (previous) => ({ completed: previous?.completed ?? 0, total: previous?.total ?? 1, running: false,
          message: "Cleanup paused. Verify the previous transaction before continuing.", compoundSignature: previous?.compoundSignature }) });
        return "stopped";
      }
    }
    const verifyRecoveryAttempt = () => {
      if (window.localStorage.getItem(cleanupBatchKey(wallet)) !== cleanupBatchRecord) throw new Error("Cleanup transaction changed in another tab. Reload and verify the saved transaction before continuing.");
      if (!receipt) return;
      const saved = loadCompoundAttempt(window.localStorage, wallet);
      if (window.localStorage.getItem(compoundAttemptKey(wallet)) !== recoveryAttemptRecord || saved.invalid ||
        saved.attempt && (resolvedAttempt.current?.signature !== saved.attempt.signature || !recoveryMayProceed(resolvedAttempt.current))) {
        throw new Error("Cleanup paused because another tab changed the transaction record. Reload and verify the other tab's transaction before continuing.");
      }
    };
    submitting.current = true; operationLifecycle.current = lifecycle.current; operationRequest.current++;
    confirmationRequest.current++; attemptSignatureRef.current = null;
    const submittedLifecycle = lifecycle.current;
    const submittedWallet = wallet;
    const submittedMint = receipt?.positionMint || positionMint!;
    const submittedIdentity = identity;
    const current = () => mounted.current && lifecycle.current === submittedLifecycle && identityRef.current === submittedIdentity && walletRef.current === submittedWallet &&
      connectionRef.current.address === submittedWallet && connectionRef.current.connected;
    dispatch({ type: "submit/prepare" });
    keepSubmitErrorRef.current = false;
    let persisted = false;
    let next: CompoundAttempt | undefined;
    try {
      const requestPrepare = () => receipt
        ? post<RecoveryPrepared | AlreadyClosedRecovery>("/api/compound-recover-prepare", { wallet: submittedWallet, compoundAccounts: receipt.compoundAccounts })
        : post<CompoundPrepared>("/api/compound-prepare", { wallet: submittedWallet, positionMint: submittedMint, sourceSignatures });
      const acceptPrepared = (prepared: CompoundPrepared | RecoveryPrepared) => {
        if (!current() || externalBlockedRef.current) throw new Error("Wallet or position changed; transaction not yet signed");
        verifyRecoveryAttempt();
        const summary = prepared.summary;
        if (!prepared.permit || !summary.simulated ||
          (receipt ? summary.operation !== "recovery" || (summary as CompoundRecoverySummary).wallet !== wallet :
            summary.operation !== "compound" || (summary as CompoundSummary).state.wallet !== wallet ||
            (summary as CompoundSummary).positionMint !== positionMint)) throw new Error("Simulation result and selection mismatch or expired");
        const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (item) => item.charCodeAt(0)));
        if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.recentBlockhash !== summary.blockhash) {
          throw new Error("Transaction payer or blockhash and preparation result mismatch");
        }
        return { prepared, summary, unsigned };
      };
      const acceptClosed = (response: CompoundPrepared | RecoveryPrepared | AlreadyClosedRecovery) => {
        if (!("alreadyClosed" in response)) return false;
        verifyRecoveryAttempt();
        if (!receipt || response.alreadyClosed !== true || response.wallet !== submittedWallet || !current() ||
          !Array.isArray(response.accounts) || response.accounts.length !== receipt.compoundAccounts.length ||
          [...response.accounts].sort().join(":") !== receipt.compoundAccounts.map(account => account.address).sort().join(":")) {
          throw new Error("Closed account verification does not match the selected harvest accounts");
        }
        const saved = loadCompoundReceipts(window.localStorage, submittedWallet);
        if (saved.invalid) throw new Error("Local harvest account records need verification before cleanup can continue");
        const key = compoundReceiptsKey(submittedWallet);
        const serialized = JSON.stringify(saved.receipts.filter(item => item.sourceSignature !== receipt.sourceSignature ||
          item.compoundAccounts.map(account => account.address).sort().join(":") !== [...response.accounts].sort().join(":")));
        window.localStorage.setItem(key, serialized);
        if (window.localStorage.getItem(key) !== serialized) throw new Error("Unable to save the cleaned account record");
        dispatch({ type: "receipts/set", receipts: loadCompoundReceipts(window.localStorage, submittedWallet).receipts });
        return true;
      };
      const response = await requestPrepare();
      if (acceptClosed(response)) return "success";
      const loaded = acceptPrepared(response as CompoundPrepared | RecoveryPrepared);
      if (!receipt) dispatch({ type: "preview/set", preview: loaded.summary as CompoundSummary });
      const { summary, unsigned } = loaded;
      if (window.localStorage.getItem(cleanupBatchKey(wallet)) !== cleanupBatchRecord) throw new Error("Cleanup transaction changed in another tab; verify original signatures before continuing.");
      verifyRecoveryAttempt();
      dispatch({ type: "stage/set", stage: "wallet" });
      // Shared pipeline send stage: the wallet sends (or signs and we relay once). The
      // compound record is saved right after send, keyed by the returned signature.
      const { signature } = await sendAndTrack({
        flow: "compound", successTitle: receipt ? "Cleanup confirmed" : "Compound confirmed", storage: window.localStorage,
        wallet: { address: submittedWallet, signTransaction: connectionRef.current.signTransaction,
          signAndSendTransaction: connectionRef.current.signAndSendTransaction },
        prepared: { transaction: unsigned, lastValidBlockHeight: summary.lastValidBlockHeight, positionMint: receipt?.positionMint || submittedMint,
          sendPermit: (loaded.prepared as { sendPermit?: string }).sendPermit,
          landedPermit: (loaded.prepared as { landedPermit?: string }).landedPermit },
        scope: receipt?.positionMint || submittedMint,
        onStage: (pipelineStage) => { if (pipelineStage === "checking" && current()) dispatch({ type: "stage/set", stage: "checking" }); },
        isCurrent: () => current() && !externalBlockedRef.current && (() => {
          try { verifyRecoveryAttempt(); } catch (error) {
            throw new TxNotSentError(error instanceof Error ? error.message : "Transaction record changed, so nothing was sent.");
          }
          if (window.localStorage.getItem(cleanupBatchKey(submittedWallet)) !== cleanupBatchRecord) {
            throw new TxNotSentError("Cleanup transaction changed in another tab, so nothing was sent. Verify the original signatures before continuing.");
          }
          return true;
        })(),
      });
      const base = { version: 1 as const, wallet: submittedWallet, positionMint: receipt?.positionMint || submittedMint,
        signature, createdAt: Date.now() };
      const created: CompoundAttempt = receipt
        ? { ...base, kind: "recovery", summary: summary as CompoundRecoverySummary, sourceSignature: receipt.sourceSignature }
        : { ...base, kind: "compound", summary: summary as CompoundSummary };
      next = created;
      persistCompoundAttempt(window.localStorage, created);
      resolvedAttempt.current = null;
      if (!receipt) autoCleanup.current = { wallet: submittedWallet, signature: created.signature, identity: submittedIdentity };
      persisted = true;
      confirmationRequest.current++;
      attemptSignatureRef.current = created.signature;
      dispatch({
        type: "submit/persisted", attempt: created,
        receipts: loadCompoundReceipts(window.localStorage, submittedWallet).receipts,
        ...(!receipt ? { feedback: { phase: "confirming" as const, signature: created.signature, message: "" } } : {}),
      });
      if (receipt) recoveryWait.current = { signature: created.signature, controller: new AbortController() };
      if (receipt) {
        const waiting = recoveryWait.current!;
        const timeout = window.setTimeout(() => waiting.controller.abort(), recoveryConfirmationMs);
        let stop!: () => void;
        const aborted = new Promise<null>(resolve => {
          stop = () => resolve(null);
          waiting.controller.signal.addEventListener("abort", stop, { once: true });
          if (waiting.controller.signal.aborted) stop();
        });
        try {
          while (current() && !waiting.controller.signal.aborted) {
            const checked = await Promise.race([reconcile(created, waiting.controller.signal), aborted]);
            if (!current()) return "stopped";
            if (!checked) { await abortableDelay(4_000, waiting.controller.signal); continue; }
            if (checked.status === "success" && (checked.chainStatus === undefined || checked.chainStatus === "success")) return "success";
            if (checked.status !== "pending") return "stopped";
            await abortableDelay(4_000, waiting.controller.signal);
          }
          return "stopped";
        } finally {
          window.clearTimeout(timeout);
          waiting.controller.signal.removeEventListener("abort", stop);
        }
      }
      void reconcile(created);
      return "stopped";
    } catch (caught) {
      if (mounted.current && lifecycle.current === submittedLifecycle && walletRef.current === submittedWallet) {
        const message = caught instanceof Error ? caught.message : "Transaction not confirmed, verify signature first";
        const sent = caught instanceof ApiRequestError ? caught.sent : undefined;
        const outcome = resolveCompoundBroadcastFailure({ persisted, sent, message });
        if (outcome.abandon && next) {
          confirmationRequest.current++;
          attemptSignatureRef.current = null;
          abandonUnsentCompoundAttempt(window.localStorage, next);
          dispatch({ type: "submit/abandoned", receipts: loadCompoundReceipts(window.localStorage, submittedWallet).receipts });
          keepSubmitErrorRef.current = true;
          setError(outcome.error, `${submittedWallet}:${submittedMint}`, next.signature, receipt?.sourceSignature ?? null);
          if (!receipt) updateFeedback(next.signature, { phase: "failed", message: outcome.error });
        } else if (outcome.keepPending) {
          keepSubmitErrorRef.current = false;
          setError("");
          if (!receipt && next) updateFeedback(next.signature, { phase: "confirming", message: "" });
        } else {
          keepSubmitErrorRef.current = true;
          const hint = !receipt && apiErrorCode(caught) === INSUFFICIENT_SOL_CODE && receipts.length > 0 ? ` ${CLEANUP_RENT_HINT}` : "";
          setError(`${outcome.error}${hint}`, `${submittedWallet}:${submittedMint}`, next?.signature ?? null, receipt?.sourceSignature ?? null);
          if (!receipt && next) updateFeedback(next.signature, { phase: "failed", message: outcome.error });
        }
      }
    } finally {
      if (recoveryWait.current?.signature === next?.signature) recoveryWait.current = null;
      submitting.current = false;
      if (!persisted && walletRef.current === submittedWallet && attemptSignatureRef.current === null) {
        attemptSignatureRef.current = attempt?.signature ?? null;
      }
      if (mounted.current && lifecycle.current === submittedLifecycle) dispatch({ type: "stage/set", stage: null });
    }
    return "stopped";
  }

  const { recover } = useCompoundRecovery({
    wallet, identity, visibleAttempt, attemptStatus, chainStatus, stage, receipts, externalBlocked,
    submit, dispatch, mounted, lifecycle, walletRef, identityRef, connectionRef, externalBlockedRef,
    cleanupRunningRef: cleanupRunning, submitting, autoCleanup, runRecoveryRef, operationLifecycleRef: operationLifecycle,
  });
  const { scanWallet, importReceipt, canImport } = useCleanupScan({
    wallet, identity, busy, importing, scan, dispatch, mounted, walletRef, scanRequest, scanRunning, submitting, operationRequest,
  });

  const retryReconcile = () => {
    if (busy) return;
    void batchCleanup.reconcile();
    if (!visibleAttempt) return;
    attemptSignatureRef.current = visibleAttempt.signature;
    void reconcile(visibleAttempt);
  };
  return { wallet, positionMint, state: visibleState, preview: visiblePreview, attempt: visibleAttempt, attemptStatus,
    confirmation: visibleAttempt && confirmation?.signature === visibleAttempt.signature ? confirmation : null,
    receipts: loadedWallet === wallet ? receipts : [],
    error: batchCleanup.error || (!errorState.receiptSignature && (errorState.identity === null || errorState.identity === identity) ? errorState.message : ""),
    recoveryError: wallet && errorState.receiptSignature && errorState.identity?.startsWith(`${wallet}:`)
      ? { sourceSignature: errorState.receiptSignature, message: errorState.message } : null,
    attemptError: visibleAttempt && errorState.identity === `${visibleAttempt.wallet}:${visibleAttempt.positionMint}` &&
      errorState.signature === visibleAttempt.signature ? errorState.message : "",
    loading, busy, stage: stage || batchCleanup.stage, walletBlocked, externalBlocked,
    historyWarning: storageInvalid ? "Local compound history cannot be verified. Check previous signatures and balance accounts before repeating an earlier operation."
      : transactionUnresolved ? "A previous compound transaction is unresolved. Verify its signature before repeating that operation; new transactions are available."
      : receiptReviewRequired ? "A previous compound transaction finalized, but its harvest details need verification. New transactions are available." : "",
    receiptReviewRequired, confirmationSlow: confirmationSlow && transactionUnresolved,
    canCompound, cancelPending, hasFees, priorReceipts, importing, canImport, importReceipt,
    scan: loadedWallet === wallet ? scan : emptyCompoundScan, scanWallet, cleanup: (loadedWallet === wallet ? cleanup : null) || batchCleanup.progress,
    cleanupBatch: batchCleanup.attempt, cleanupAll: async () => {
      if (cleanupRunning.current || submitting.current || busy) return;
      dispatch({ type: "cleanup/set", cleanup: null });
      await batchCleanup.start(receipts);
    },
    canCleanup: !!wallet && connection.connected && loadedWallet === wallet && !busy && !externalBlocked && !storageInvalid && batchCleanup.loaded && !batchCleanup.unresolved && !batchCleanup.invalid &&
      (!visibleAttempt || recoveryMayProceed({ status: attemptStatus ?? "pending", chainStatus: chainStatus ?? undefined })) && receipts.length > 0,
    ready: !!wallet && connection.connected && !walletBlocked && !externalBlocked && !batchCleanup.unresolved && !batchCleanup.invalid,
    refreshState, compound: () => { void submit(); },
    feedback,
    feedbackSlow: confirmationSlow,
    dismissFeedback: () => {
      const done = feedback?.phase === "success";
      dispatch({ type: "feedback/set", feedback: null });
      // OK on success re-reads the position so the remaining Harvest shows without a page reload.
      if (done) { void refreshState(); onConfirmedRef.current?.(); }
    }, recover, retryReconcile,
    storageKey: wallet ? compoundAttemptKey(wallet) : null };
}

export type CompoundController = ReturnType<typeof useCompoundController>;
