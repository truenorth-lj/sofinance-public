"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AtomicStatus } from "@/lib/attempt-status";
import { loadSelectedAttempt, readSelectedHistory, type SelectedAttempt } from "@/lib/selected-attempt";
import { readObsoleteAttempts } from "@/lib/obsolete-attempt";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import type { SelectedPositionState } from "@sofinance/engine/selected-state";

type StatusResponse = { status: AtomicStatus; state: SelectedPositionState | null; signature: string; transactionError?: unknown };
type ApiError = { error: string };
type SelectedAttemptOptions = {
  wallet?: string;
  busy: boolean;
  // Stable identity ports read the facade's original refs, at their original effect times.
  getLifetime: () => object | null;
  isWalletCurrent: (wallet: string) => boolean;
  isSubmitting: () => boolean;
};

/** Selected history and reconciliation only; submission and persistence stay in the facade. */
export function useSelectedAttempt({ wallet, busy, getLifetime, isWalletCurrent, isSubmitting }: SelectedAttemptOptions) {
  const [attempt, setAttempt] = useState<SelectedAttempt | null>(null);
  const [attemptStatus, setAttemptStatus] = useState<AtomicStatus | null>(null);
  const [history, setHistory] = useState<SelectedAttempt[]>([]);
  const [verificationError, setVerificationError] = useState("");
  const [obsoletePending, setObsoletePending] = useState(false);
  const [attemptLoadedWallet, setAttemptLoadedWallet] = useState<string | null>(null);
  const reconcileRequestRef = useRef(0);
  const attemptSignatureRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    // Suspense reconnects layout effects without reloading passive storage effects.
    // Restore the current record after submission settles, never an old run's record.
    if (!isSubmitting() && attempt && attempt.wallet === wallet && attemptSignatureRef.current === null) {
      attemptSignatureRef.current = attempt.signature;
    }
  }, [attempt, wallet, busy, isSubmitting]);

  // Revocation is synchronous, before the new prepare command can yield.
  const beginSubmission = useCallback(() => {
    reconcileRequestRef.current++;
    attemptSignatureRef.current = null;
  }, []);
  const restoreSignature = useCallback((signature: string | null) => {
    if (attemptSignatureRef.current === null) attemptSignatureRef.current = signature;
  }, []);
  // Called only after the unchanged archive/write/readback helper succeeds.
  // Keep recovery pointed at the durable record even if history enumeration fails.
  // The exception still propagates to the submission command and prevents sending.
  const publishPersisted = useCallback((current: SelectedAttempt) => {
    try {
      setHistory(readSelectedHistory(window.localStorage, current.wallet));
    } finally {
      attemptSignatureRef.current = current.signature;
      setAttempt(current); setAttemptStatus("pending");
    }
  }, []);

  const reconcileObsolete = useCallback(async (address: string) => {
    const { attempts, invalid } = readObsoleteAttempts(window.localStorage, address);
    let pending = invalid;
    for (const old of attempts) {
      const response = await fetch("/api/transaction-finality", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: old.signature, lastValidBlockHeight: old.lastValidBlockHeight }), cache: "no-store",
        signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("Previous transaction could not be verified. Check its status before starting again.");
      const data = await response.json() as { status: "finalized" | "failed" | "expired" | "pending" };
      if (!["finalized", "failed", "expired"].includes(data.status)) pending = true;
    }
    return pending;
  }, []);

  const startWalletLoad = useCallback((wallet: string | undefined) => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      reconcileRequestRef.current++;
      setVerificationError("");
      setHistory([]);
      if (!wallet) { setAttempt(null); attemptSignatureRef.current = null; setHistory([]); setAttemptStatus(null); setObsoletePending(false); setAttemptLoadedWallet(null); return; }
      try {
        const saved = loadSelectedAttempt(window.localStorage, wallet);
        setAttempt(saved.attempt);
        attemptSignatureRef.current = saved.attempt?.signature ?? null;
        setHistory(readSelectedHistory(window.localStorage, wallet));
        setAttemptStatus(saved.invalid ? "manual-review" : saved.attempt ? "pending" : null);
        const legacy = readObsoleteAttempts(window.localStorage, wallet);
        setObsoletePending(legacy.invalid || legacy.attempts.length > 0);
        setAttemptLoadedWallet(wallet);
      } catch {
        attemptSignatureRef.current = null;
        setAttempt(null); setAttemptStatus("manual-review"); setObsoletePending(true); setAttemptLoadedWallet(wallet);
      }
      // Old network lookups are independent of preview readiness.
      void reconcileObsolete(wallet).catch(() => true).then((pending) => {
        if (!cancelled && isWalletCurrent(wallet)) setObsoletePending(pending);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [isWalletCurrent, reconcileObsolete]);

  const reconcileAttempt = useCallback(async (current: SelectedAttempt) => {
    const lifetime = getLifetime();
    if (!lifetime) return;
    const requestId = ++reconcileRequestRef.current;
    const ownsResult = () => getLifetime() === lifetime && isWalletCurrent(current.wallet) && attemptSignatureRef.current === current.signature &&
      requestId === reconcileRequestRef.current;
    try {
    const response = await fetch("/api/selected-status", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: current.wallet, selection: current.selection, poolId: current.poolId,
        positionAccount: current.positionAccount, signature: current.signature,
        startingLiquidity: current.startingLiquidity, expectedLiquidity: current.expectedLiquidity,
        startingBalances: current.startingBalances, lastValidBlockHeight: current.lastValidBlockHeight }), cache: "no-store",
      signal: AbortSignal.timeout(8_000) });
    const data = await response.json() as StatusResponse | ApiError;
    if (!ownsResult()) return;
    if (!response.ok) throw new Error((data as ApiError).error);
    const checked = data as StatusResponse;
    if (checked.signature !== current.signature || !["pending", "expired", "failed", "success", "manual-review"].includes(checked.status)) {
      throw new Error("Transaction verification returned a different signature or invalid status");
    }
    setAttemptStatus(checked.status);
    if (checked.status === "success") notifyPositionHistoryChange(current.selection.positionMint, current.signature);
    setVerificationError("");
    } catch (caught) {
      if (ownsResult()) setVerificationError(caught instanceof Error ? caught.message : "Transaction status verification failed");
    }
  }, [getLifetime, isWalletCurrent]);

  const historyWarning = wallet && attemptLoadedWallet === wallet && (verificationError || obsoletePending ||
    attemptStatus === "pending" || attemptStatus === "manual-review")
    ? "Previous transaction is unconfirmed or needs verification. It may still succeed; starting again may add liquidity twice." : "";
  const retryReconcile = () => { if (attempt && !busy) void reconcileAttempt(attempt); };
  const retryObsoleteReconcile = () => {
    if (!wallet) return;
    void reconcileObsolete(wallet).then((pending) => { if (isWalletCurrent(wallet)) setObsoletePending(pending); })
      .catch(() => { if (isWalletCurrent(wallet)) setObsoletePending(true); });
  };
  return { attempt, attemptStatus, history, verificationError, obsoletePending, historyWarning,
    beginSubmission, restoreSignature, publishPersisted, reconcileAttempt, retryReconcile, retryObsoleteReconcile,
    startWalletLoad };
}

/**
 * Register passive load/poll after the facade resets, discovery/state reads and clock,
 * before preview. Keeping this separate preserves layout-only Suspense restoration
 * and the established passive setup/cleanup order without sharing mutable refs.
 */
export function useSelectedAttemptEffects(
  { wallet, busy }: Pick<SelectedAttemptOptions, "wallet" | "busy">,
  { startWalletLoad, attempt, attemptStatus, reconcileAttempt }: Pick<ReturnType<typeof useSelectedAttempt>,
    "startWalletLoad" | "attempt" | "attemptStatus" | "reconcileAttempt">,
) {
  useEffect(() => startWalletLoad(wallet), [wallet, startWalletLoad]);

  useEffect(() => {
    if (busy || !attempt || attempt.wallet !== wallet || ["success", "expired", "failed", "manual-review"].includes(attemptStatus || "")) return;
    let checking = false;
    const check = () => {
      if (checking) return;
      checking = true;
      void reconcileAttempt(attempt).finally(() => { checking = false; });
    };
    const timer = window.setTimeout(check, 0);
    const poll = window.setInterval(check, 4_000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); };
  }, [attempt, attemptStatus, busy, wallet, reconcileAttempt]);

}
