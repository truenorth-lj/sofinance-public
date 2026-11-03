"use client";

/**
 * One lock per position across every registry tool (Add, Withdraw, Claim fees, Compound), PM review of #289.
 *
 * Each panel has its own pipeline, and a tab switch unmounts the panel while its send carries on, so a per-panel
 * `locked` is not enough: a Claim that lands while a Compound is being prepared would make the Compound's deposit
 * (sized from the fees it simulated) draw that amount from the wallet instead. So the lock lives here, outside React
 * state, keyed by `position.key`, and covers the whole send of any op on that position:
 *   - in flight: from prepare through the wallet (and the Solana check after a wallet error), for every step of a plan;
 *   - confirming: any signature it sent whose notice is still loading (a dismissed notice does not lock forever);
 *   - a cancelled send of any of these ops on this position that is still being checked on Solana.
 * Nothing here knows which DEX the position belongs to.
 */
import { useCallback, useSyncExternalStore } from "react";
import { cancelCheckKey, findTxNotice, isCancelCheckPending, noticeIdFor, subscribeCancelChecks, subscribeTxNotices, type TxFlow } from "@/lib/tx-pipeline";

/** The flows a position tool sends (recovery is a withdraw). */
const POSITION_FLOWS: readonly TxFlow[] = ["add", "withdraw", "claim", "compound"];

const inFlight = new Map<string, number>();
const sent = new Map<string, Set<string>>();
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

function subscribe(listener: () => void) {
  listeners.add(listener);
  const offNotices = subscribeTxNotices(listener);
  const offCancels = subscribeCancelChecks(listener);
  return () => { listeners.delete(listener); offNotices(); offCancels(); };
}

/** A send of this position is preparing, in the wallet, being checked, or confirming. */
export function isPositionOpBusy(key: string): boolean {
  if ((inFlight.get(key) ?? 0) > 0) return true;
  const signatures = sent.get(key);
  if (!signatures) return false;
  for (const signature of signatures) {
    if (findTxNotice(noticeIdFor(signature))?.state === "loading") return true;
    signatures.delete(signature); // settled or dismissed: forget it
  }
  if (!signatures.size) sent.delete(key);
  return false;
}

/** A cancelled send of any position op on this position is still being checked on Solana. */
export function isPositionCancelPending(key: string): boolean {
  return POSITION_FLOWS.some((flow) => isCancelCheckPending(cancelCheckKey(flow, key)));
}

/** Claims the position for one send (all of its steps); returns the release, or null when another op holds it. */
export function beginPositionOp(key: string): (() => void) | null {
  if (isPositionOpBusy(key) || isPositionCancelPending(key)) return null;
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (inFlight.get(key) ?? 1) - 1;
    if (left > 0) inFlight.set(key, left); else inFlight.delete(key);
    emit();
  };
}

/** A step of this position's send went out: keep the position locked until its notice settles. */
export function trackPositionSignature(key: string, signature: string) {
  const signatures = sent.get(key) ?? new Set<string>();
  signatures.add(signature);
  sent.set(key, signatures);
  emit();
}

export type PositionOpLock = { busy: boolean; cancelPending: boolean };
const FREE = "0:0";

/** The shared lock for one position, for every panel (survives tab switches: the state is not the panel's). */
export function usePositionOpLock(key: string): PositionOpLock {
  const read = useCallback(() => `${isPositionOpBusy(key) ? 1 : 0}:${isPositionCancelPending(key) ? 1 : 0}`, [key]);
  const snapshot = useSyncExternalStore(subscribe, read, () => FREE);
  return { busy: snapshot[0] === "1", cancelPending: snapshot[2] === "1" };
}

/** Test hook. */
export function resetPositionOpLocks() { inFlight.clear(); sent.clear(); emit(); }
