import { useMemo, useSyncExternalStore } from "react";

/**
 * Activity V1 (LJ 11/14): the results of this session's transactions on each position (compound, add, withdraw, claim,
 * cleanup), newest first. Kept in memory only: nothing is stored, so a reload starts an empty list. Compound records that
 * the compound controller already keeps in localStorage are shown next to it by the Activity popup, as before.
 */
export type ActivityStatus = "pending" | "success" | "failed";

export type ActivityEntry = {
  /** One entry per transaction (e.g. `compound:<signature>`): recording the same id again updates it in place. */
  id: string;
  positionKey: string;
  title: string;
  status: ActivityStatus;
  detail?: string;
  signature?: string;
  /** When it was first recorded (ms). */
  at: number;
  /** Order of first recording (newest first even within the same millisecond). */
  seq: number;
};

export type ActivityInput = Omit<ActivityEntry, "at" | "seq">;

let entries: readonly ActivityEntry[] = [];
let nextSeq = 0;
const listeners = new Set<() => void>();
const emit = () => { for (const listener of listeners) listener(); };

export function recordActivity(input: ActivityInput, now = Date.now()) {
  const existing = entries.find((entry) => entry.id === input.id);
  if (existing && existing.positionKey === input.positionKey && existing.title === input.title && existing.status === input.status
    && existing.detail === input.detail && existing.signature === input.signature) return;
  const entry: ActivityEntry = { ...input, at: existing?.at ?? now, seq: existing?.seq ?? nextSeq++ };
  entries = existing ? entries.map((item) => item.id === input.id ? entry : item) : [...entries, entry];
  emit();
}

/** A position's entries, newest first. */
export function activityFor(positionKey: string, list: readonly ActivityEntry[] = entries): ActivityEntry[] {
  return list.filter((entry) => entry.positionKey === positionKey).sort((a, b) => b.seq - a.seq);
}

const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => entries;

export function useSessionActivity(positionKey: string): ActivityEntry[] {
  const list = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => activityFor(positionKey, list), [positionKey, list]);
}

/** Tests only. */
export function resetSessionActivity() { entries = []; nextSeq = 0; emit(); }
