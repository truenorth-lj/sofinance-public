"use client";

import { useCallback, useEffect, useLayoutEffect, useReducer, useRef } from "react";
import { abandonUnsentOpenAttempt, loadOpenAttempt, persistOpenAttempt,
  type OpenAttempt, type OpenAttemptStatus } from "@/lib/open-attempt";
import { openAttemptReducer, openAttemptPending, UNLOADED_OPEN_ATTEMPT, visibleOpenAttempt } from "./transactions/open/open-attempt-model";

const statuses: OpenAttemptStatus[] = ["pending", "confirmed", "failed", "expired", "manual-review"];

export function useOpenAttempt(wallet: string | undefined) {
  const [state, dispatch] = useReducer(openAttemptReducer, UNLOADED_OPEN_ATTEMPT);
  const walletRef = useRef(wallet);
  const attemptRef = useRef<OpenAttempt | null>(null);
  const checkingRef = useRef<string | null>(null);
  const activeRef = useRef(false);
  useLayoutEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  useLayoutEffect(() => { walletRef.current = wallet; attemptRef.current = null; }, [wallet]);

  useEffect(() => {
    if (!wallet) return;
    const timer = window.setTimeout(() => {
      try {
        const saved = loadOpenAttempt(window.localStorage, wallet);
        attemptRef.current = saved.attempt;
        dispatch({ type: "historyLoaded", wallet, attempt: saved.attempt, invalid: saved.invalid });
      } catch {
        dispatch({ type: "historyUnavailable", wallet });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);

  const reconcile = useCallback(async (attempt: OpenAttempt, signal?: AbortSignal) => {
    if (checkingRef.current === attempt.signature) return;
    checkingRef.current = attempt.signature;
    const current = () => activeRef.current && !signal?.aborted && walletRef.current === attempt.wallet && attemptRef.current?.signature === attempt.signature;
    try {
      const response = await fetch("/api/open-status", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet: attempt.wallet, attempt }), cache: "no-store",
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]) });
      const result = await response.json() as { signature?: string; status?: OpenAttemptStatus; error?: string };
      if (!current()) return;
      if (!response.ok) throw new Error(result.error || "Unable to verify open-position transaction");
      if (result.signature !== attempt.signature || !result.status || !statuses.includes(result.status)) throw new Error("Open-position verification signature or status mismatch");
      const status = result.status;
      dispatch({ type: "statusObserved", attempt, status });
    } catch (error) {
      if (current()) dispatch({ type: "verificationFailed",
        error: error instanceof Error ? error.message : "Unable to verify the original open-position signature" });
    } finally {
      if (checkingRef.current === attempt.signature) checkingRef.current = null;
    }
  }, []);

  const visible = visibleOpenAttempt(state, wallet);
  const pending = openAttemptPending(visible, wallet);
  useEffect(() => {
    if (!visible?.attempt || !pending) return;
    const attempt = visible.attempt;
    const aborter = new AbortController();
    const timer = window.setTimeout(() => void reconcile(attempt, aborter.signal), 0);
    const interval = window.setInterval(() => void reconcile(attempt, aborter.signal), 3_000);
    return () => { aborter.abort(); window.clearTimeout(timer); window.clearInterval(interval); };
  }, [visible?.attempt, pending, reconcile]);

  const track = (attempt: OpenAttempt) => {
    if (!activeRef.current || walletRef.current !== attempt.wallet) throw new Error("Wallet or signing page changed; transaction not sent");
    const saved = loadOpenAttempt(window.localStorage, attempt.wallet);
    if (saved.invalid || saved.attempt && saved.attempt.signature !== attemptRef.current?.signature) {
      throw new Error("Open-position history changed. Reload to verify the original signature before opening again.");
    }
    persistOpenAttempt(window.localStorage, attempt);
    attemptRef.current = attempt;
    dispatch({ type: "attemptTracked", attempt });
  };
  const markUnsent = (attempt: OpenAttempt) => {
    abandonUnsentOpenAttempt(window.localStorage, attempt);
    if (!activeRef.current || walletRef.current !== attempt.wallet || attemptRef.current?.signature !== attempt.signature) return;
    attemptRef.current = null;
    dispatch({ type: "markedUnsent", attempt });
  };
  return { attempt: visible?.attempt ?? null, status: visible?.status ?? null, error: visible?.error ?? "",
    pending, loaded: !wallet || visible !== null, track, markUnsent,
    dismissTerminal: () => {
      if (!pending && visible && visible.kind !== "invalid") dispatch({ type: "terminalDismissed", snapshot: visible });
    },
    retry: () => { if (visible?.attempt) void reconcile(visible.attempt); } };
}
