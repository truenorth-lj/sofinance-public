"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { abandonUnsentOpenAttempt, loadOpenAttempt, persistOpenAttempt,
  type OpenAttempt, type OpenAttemptStatus } from "@/lib/open-attempt";

type State = { wallet: string; attempt: OpenAttempt | null; status: OpenAttemptStatus | null; error: string; invalid: boolean };
const statuses: OpenAttemptStatus[] = ["pending", "confirmed", "failed", "expired", "manual-review"];

export function useOpenAttempt(wallet: string | undefined) {
  const [state, setState] = useState<State | null>(null);
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
        setState({ wallet, attempt: saved.attempt, status: saved.invalid ? "manual-review" : saved.attempt ? "pending" : null,
          invalid: saved.invalid, error: saved.invalid ? "Local open-position history cannot be verified. Check previous signatures before opening again." : "" });
      } catch {
        setState({ wallet, attempt: null, status: "manual-review", invalid: true,
          error: "Unable to read open-position history. Check previous signatures before opening again." });
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
      setState({ wallet: attempt.wallet, attempt, status, invalid: false,
        error: status === "failed" ? "Open-position transaction failed on-chain. You can prepare a new transaction."
          : status === "expired" ? "Open-position transaction expired without landing. You can prepare a new transaction."
            : status === "manual-review" ? "The original transaction needs manual verification. Check its signature before opening again." : "" });
    } catch (error) {
      if (current()) setState(previous => previous ? { ...previous,
        error: error instanceof Error ? error.message : "Unable to verify the original open-position signature" } : previous);
    } finally {
      if (checkingRef.current === attempt.signature) checkingRef.current = null;
    }
  }, []);

  const visible = state?.wallet === wallet ? state : null;
  const pending = Boolean(wallet && (!visible || visible.invalid || visible.status === "pending" || visible.status === "manual-review"));
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
    setState({ wallet: attempt.wallet, attempt, status: "pending", invalid: false, error: "" });
  };
  const markUnsent = (attempt: OpenAttempt) => {
    abandonUnsentOpenAttempt(window.localStorage, attempt);
    if (!activeRef.current || walletRef.current !== attempt.wallet || attemptRef.current?.signature !== attempt.signature) return;
    attemptRef.current = null;
    setState({ wallet: attempt.wallet, attempt, status: "unsent", invalid: false, error: "" });
  };
  return { attempt: visible?.attempt ?? null, status: visible?.status ?? null, error: visible?.error ?? "",
    pending, loaded: !wallet || visible !== null, track, markUnsent,
    dismissTerminal: () => {
      if (!pending && visible) setState({ ...visible, status: null, error: "" });
    },
    retry: () => { if (visible?.attempt) void reconcile(visible.attempt); } };
}
