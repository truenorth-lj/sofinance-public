"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createCompoundAllRunner, type CleanupOutcome, type CompoundAllDeps, type CompoundAllRunner } from "@/lib/compound-all/runner";
import type { CompoundAllRowInput, CompoundAllState, RowStage } from "@/lib/compound-all/state";
import type { CleanupBatchOutcome, CleanupBatchStage } from "../use-cleanup-batch-controller";
import type { CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundAllActions } from "./compound-all-dialog";

/** The part of the selected-position compound controller compound all shares (its cleanup batch, admission and records). */
type CompoundAllCleanupHost = {
  reloadSaved: () => void;
  cleanupAdmission: () => boolean;
  startCleanupBatch: (receipts: CompoundReceipt[], onStage?: (stage: CleanupBatchStage) => void) => Promise<CleanupBatchOutcome>;
};

const CLEANUP_ADMISSION_WAIT_MS = 30_000;
export const CLEANUP_WAITING = "An earlier compound is still being checked on Solana, so the cleanup did not start. Retry the cleanup in a moment, or use the recovery page.";
const stageOf = (stage: CleanupBatchStage): RowStage => stage === "preparing" ? "preparing" : stage === "wallet" ? "awaiting-wallet" : "confirming";

/**
 * The cleanup row through the existing cleanup batch (`useCleanupBatchController().start` of the selected-position
 * controller): its records are re-read first, and it starts only once that controller's own admission (`canStart`)
 * holds, i.e. the last saved compound settled on Solana.
 */
export function cleanupThroughHost(host: CompoundAllCleanupHost, timing: { waitMs?: number; intervalMs?: number } = {}) {
  return async (receipts: CompoundReceipt[], onStage: (stage: RowStage) => void): Promise<CleanupOutcome> => {
    host.reloadSaved();
    const deadline = Date.now() + (timing.waitMs ?? CLEANUP_ADMISSION_WAIT_MS);
    while (!host.cleanupAdmission()) {
      if (Date.now() >= deadline) return { status: "failed", error: CLEANUP_WAITING };
      await new Promise((resolve) => setTimeout(resolve, timing.intervalMs ?? 500));
    }
    const outcome = await host.startCleanupBatch(receipts, (stage) => onStage(stageOf(stage)));
    return outcome.status === "done" ? { status: "done", signatures: outcome.signatures } : { status: "failed", error: outcome.error, outcomeUnconfirmed: outcome.status === "failed" ? outcome.outcomeUnconfirmed : undefined };
  };
}

/**
 * One Compound all run at a time: a fresh runner over the rows listed when the popup opens, its state for the popup,
 * and the user's answers. A run in progress survives closing (it can't be closed mid-run) and stops if the wallet changes.
 */
export function useCompoundAll({ wallet, createDeps, onEnded }: {
  wallet: string | null; createDeps: () => CompoundAllDeps | null; onEnded?: (state: CompoundAllState) => void;
}) {
  const [runner, setRunner] = useState<CompoundAllRunner | null>(null);
  const [state, setState] = useState<CompoundAllState | null>(null);
  const [open, setOpen] = useState(false);
  const latest = useRef({ createDeps, onEnded });
  useEffect(() => { latest.current = { createDeps, onEnded }; });
  const running = !!state && !["setup", "finished", "cancelled"].includes(state.phase);

  useEffect(() => {
    if (!runner) return;
    return runner.subscribe(setState);
  }, [runner]);
  // A different wallet (or a disconnect) stops the run after the row in flight.
  const runWallet = useRef<string | null>(null);
  useEffect(() => {
    if (runner && runWallet.current !== wallet) runner.cancel();
  }, [runner, wallet]);

  const openWith = useCallback((rows: readonly CompoundAllRowInput[]) => {
    if (runner && state && !["finished", "cancelled", "setup"].includes(state.phase)) { setOpen(true); return; }
    const deps = latest.current.createDeps();
    if (!deps || !rows.length) return;
    const next = createCompoundAllRunner(rows, deps);
    runWallet.current = wallet;
    setRunner(next); setState(next.state); setOpen(true);
  }, [runner, state, wallet]);
  const close = useCallback(() => {
    if (running) return;
    setOpen(false);
    if (state?.phase === "setup") runner?.cancel();
  }, [running, runner, state]);

  const actions: CompoundAllActions = {
    select: (key, selected) => runner?.select(key, selected),
    start: () => { if (!runner) return; void runner.start().then((ended) => latest.current.onEnded?.(ended)); },
    retry: () => runner?.retry(), skip: () => runner?.skip(), continue: () => runner?.continue(), cancel: () => runner?.cancel(),
    runCleanup: () => runner?.runCleanup(), skipCleanup: () => runner?.skipCleanup(),
  };
  return { open, state, running, openWith, close, actions };
}
