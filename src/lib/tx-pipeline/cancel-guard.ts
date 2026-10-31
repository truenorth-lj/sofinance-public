import { useCallback, useSyncExternalStore } from "react";
import type { TxFlow } from "./errors";

/**
 * After a wallet cancel (code 4001) the form unlocks at once, but the wallet may still have broadcast, so Solana is
 * checked in the background until the blockhash expires. Until that check ends, the SAME flow on the SAME position
 * (or pool) may not be sent again: a second identical add could double the deposit. Other flows and positions are free.
 */
export const CANCEL_CHECK_PENDING_COPY = "Cancelled — you can retry in about a minute";

const pending = new Map<string, number>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

/** `flow:scope`; scope is the position mint (add, withdraw, compound) or pool id (open, its SOL swap step). */
export const cancelCheckKey = (flow: TxFlow, scope?: string) => `${flow}:${scope ?? ""}`;

export function isCancelCheckPending(key: string) {
  return (pending.get(key) ?? 0) > 0;
}

/** Holds `key` until `done` settles (resolve or reject). */
export function holdCancelCheck(key: string, done: Promise<unknown>) {
  pending.set(key, (pending.get(key) ?? 0) + 1);
  emit();
  const release = () => {
    const left = (pending.get(key) ?? 1) - 1;
    if (left > 0) pending.set(key, left); else pending.delete(key);
    emit();
  };
  void done.then(release, release);
}

export function subscribeCancelChecks(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** True while a cancelled send of this flow + scope is still being checked on-chain. */
export function useCancelCheckPending(flow: TxFlow, scope?: string) {
  const key = cancelCheckKey(flow, scope);
  const read = useCallback(() => isCancelCheckPending(key), [key]);
  return useSyncExternalStore(subscribeCancelChecks, read, () => false);
}

/** Test hook. */
export function resetCancelChecks() { pending.clear(); emit(); }
