"use client";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { parseSolSwapAttempt, readSolSwapAttempt, requireSolSwapStorage, solSwapAttemptKey,
  SOL_SWAP_STORAGE_ERROR, subscribeSolSwapAttempt } from "./sol-swap-attempt-store";
import { reconcileSolSwapStep } from "./sol-swap-step-client";
import type { PendingSolSwapReceipt } from "./sol-swap-receipt-store";

const serverSnapshot = () => null;

/** An unresolved swap blocks every new open for its wallet, even on a different pool. */
export function useSolSwapRecovery(options: { wallet?: string; connected: boolean; blocked: boolean;
  onReceipt: (receipt: PendingSolSwapReceipt) => void }) {
  const { wallet } = options;
  const getSnapshot = useCallback(() => {
    if (!wallet) return null;
    try { return requireSolSwapStorage().getItem(solSwapAttemptKey(wallet)); }
    catch { return "unreadable"; }
  }, [wallet]);
  const raw = useSyncExternalStore(subscribeSolSwapAttempt, getSnapshot, serverSnapshot);
  const snapshot = useMemo(() => {
    try { return { attempt: wallet ? parseSolSwapAttempt(raw, wallet) : null, invalid: false }; }
    catch { return { attempt: null, invalid: true }; }
  }, [raw, wallet]);
  const latest = useRef(options);
  useLayoutEffect(() => { latest.current = options; });
  const generation = useRef<object | null>(null);
  useLayoutEffect(() => {
    generation.current = {};
    return () => { generation.current = null; };
  }, [wallet, options.connected]);
  const running = useRef<object | null>(null);
  const [checkingWallet, setCheckingWallet] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ wallet: string; message: string } | null>(null);
  const recheck = useCallback(async () => {
    const currentOptions = latest.current;
    if (!wallet || wallet !== currentOptions.wallet || !currentOptions.connected || currentOptions.blocked || running.current || !generation.current) return;
    const token = generation.current, owner = {};
    const current = () => generation.current === token && latest.current.wallet === wallet && latest.current.connected && !latest.current.blocked;
    running.current = owner;
    setCheckingWallet(wallet); setFailure(null);
    try {
      const storage = requireSolSwapStorage();
      const attempt = readSolSwapAttempt(storage, wallet);
      if (!attempt) return;
      const receipt = await reconcileSolSwapStep(attempt, { storage, current });
      if (current()) latest.current.onReceipt(receipt);
    } catch (error) {
      if (current()) setFailure({ wallet, message: error instanceof Error ? error.message : "Check the original SOL swap before opening again." });
    } finally {
      if (running.current === owner) {
        running.current = null;
        setCheckingWallet(null);
      }
    }
  }, [wallet]);
  return { ...snapshot, checking: checkingWallet === wallet,
    error: snapshot.invalid ? SOL_SWAP_STORAGE_ERROR : failure && failure.wallet === wallet ? failure.message : "", recheck };
}
