"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  clearTxInterruption, detachTxRetry, dismissTxNotice, noticeIdFor, pollSignature, readTxInterruption, recordTxInterruption, runTx, TxCancelCheckPendingError,
  TxRunError, useCancelCheckPending, useTxNotices, type PreparedTx, type TxInterruption, type RunTxResult, type TxAdapter, type TxChainStatus, type TxFailureKind, type TxStage, type TxWallet,
} from "@/lib/tx-pipeline";

export type TxPipelineStatus = "idle" | TxStage | "success" | "failed";
/** Where a multi-step run is: `of` is known once a step has been prepared (the route reports it). */
export type TxStepProgress = { step: number; of?: number };
export type TxPipelineState = {
  status: TxPipelineStatus; signature?: string; error?: string; kind?: TxFailureKind | "landed"; retryable?: boolean;
  /** "expiring": seconds until the voided request's blockhash should have expired (an estimate for the countdown). */
  secondsLeft?: number;
  /** Set on multi-step runs. */
  step?: TxStepProgress;
  /** Confirming a step that is not the last: its confirmation is not the run's success. */
  intermediate?: boolean;
};

/**
 * A multi-step run: `next` gets each sent step and returns the next step's input, or null when that step was the last.
 * The next step is prepared only after the previous one is confirmed on Solana (a later step reads what the earlier one
 * created, at "confirmed"). `progress` reads "step n of m" from a prepared step, for plain messages.
 */
export type TxStepPlan<Input, Prepared> = {
  next: (sent: RunTxResult<Prepared>, earlier: readonly RunTxResult<Prepared>[]) => Input | null;
  progress?: (prepared: Prepared) => TxStepProgress;
};
/** `earlier`: the steps already confirmed before `index` (a Try again after step 2 failed resumes with step 1's). */
type PlanRun<Input, Prepared> = TxStepPlan<Input, Prepared> & { input: Input; index: number; of?: number; earlier: RunTxResult<Prepared>[] };

/** More steps than any plan has: stop rather than loop on a route that never says "done". */
export const MAX_TX_PLAN_STEPS = 8;

const stepName = (index: number, of?: number) => of && of > 1 ? `step ${index} of ${of}` : `step ${index}`;
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Plain words for a step that is not the last and did not confirm: the next step was not started. */
export function unconfirmedStepMessage(index: number, of: number | undefined, status: Exclude<TxChainStatus, "confirmed">): string {
  const step = capital(stepName(index, of));
  const next = `${stepName(index + 1, of)} was not started`;
  if (status === "failed") return `${step} failed on Solana, so ${next}. Nothing changed except the network fee.`;
  if (status === "expired") return `${step} expired before it landed, so nothing changed and ${next}.`;
  return `${step} is still unconfirmed, so ${next}. Check it on Solscan before trying again; it may still land.`;
}

/** A later step that could not be prepared, signed or sent: say which steps are already on Solana. */
export function laterStepFailureMessage(index: number, of: number | undefined, cause: string): string {
  const done = index - 1 === 1 ? "Step 1" : `Steps 1–${index - 1}`;
  return `${done}${of ? ` of ${of}` : ""} ${index - 1 === 1 ? "is" : "are"} confirmed on Solana, but ${stepName(index, of)} did not go through: ${cause}`;
}

/**
 * React binding for the shared pipeline. A flow passes its adapter and gets back a stage,
 * a plain error, a one-tap retry, `closeLocked` (true while preparing or in the wallet,
 * so a stray backdrop click cannot abandon a signature request) and `locked` (also true while
 * checking Solana after a wallet error and while confirming: no second send, no re-quote).
 *
 * `scope` (e.g. the selected position mint) feeds `cancelPending`: true while a cancelled send of this flow on this
 * position is still being checked on-chain in the background; the form shows `CANCEL_CHECK_PENDING_COPY` and
 * keeps its submit disabled (runTx refuses that send anyway).
 */
export function useTxPipeline<Input, Prepared extends PreparedTx>(adapter: TxAdapter<Input, Prepared>, wallet: TxWallet | null,
  options: { scope?: string; inlineErrors?: boolean } = {}) {
  const [owned, setOwned] = useState<{ wallet?: string; state: TxPipelineState }>({ state: { status: "idle" } });
  const generation = useRef(0);
  const mounted = useRef(true);
  /** Aborted on unmount: stops a run's wallet-prompt deadline timer and its expiry wait. */
  const aborter = useRef(new AbortController());
  const busy = useRef(false);
  const lockedRef = useRef(false);
  const latest = useRef({ adapter, wallet });
  const latestInline = useRef(options.inlineErrors ?? false);
  useLayoutEffect(() => { latestInline.current = options.inlineErrors ?? false; });
  const latestScope = useRef(options.scope);
  useLayoutEffect(() => { latestScope.current = options.scope; });
  // A run of this flow + scope that an earlier mount left half-way (read after mount: storage is browser-only).
  const [interrupted, setInterrupted] = useState<TxInterruption | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => setInterrupted(options.scope ? readTxInterruption(adapter.flow, options.scope) : null), 0);
    return () => window.clearTimeout(timer);
  }, [adapter.flow, options.scope]);
  const dismissInterrupted = useCallback(() => {
    if (latestScope.current) clearTxInterruption(latest.current.adapter.flow, latestScope.current);
    setInterrupted(null);
  }, []);
  useLayoutEffect(() => { latest.current = { adapter, wallet }; });
  const planRef = useRef<(plan: PlanRun<Input, Prepared>) => Promise<unknown>>(async () => null);
  const lastPlan = useRef<PlanRun<Input, Prepared> | null>(null);
  const retry = useCallback(() => { if (lastPlan.current && !busy.current) void planRef.current(lastPlan.current); }, []);
  const walletAddress = wallet?.address;

  /** Runs the plan from `plan.index`; resolves with the sent steps when the last one was sent, else null. */
  const runPlan = useCallback(async (plan: PlanRun<Input, Prepared>): Promise<RunTxResult<Prepared>[] | null> => {
    const current = latest.current;
    if (busy.current || lockedRef.current || !current.wallet) return null;
    const own = ++generation.current;
    const submittedWallet = current.wallet.address;
    const isOwner = () => mounted.current && generation.current === own && latest.current.wallet?.address === submittedWallet;
    busy.current = true;
    const setState = (state: TxPipelineState) => setOwned({ wallet: submittedWallet, state });
    const sent = [...plan.earlier];
    const start = { ...plan };
    let { input, index, of } = plan;
    const scope = latestScope.current;
    /** The run lost its owner (unmount, wallet switch) after `sent` reached Solana and before `nextStep` was sent. */
    const markInterrupted = (nextStep: number) => {
      if (!sent.length || !scope) return;
      recordTxInterruption({ flow: current.adapter.flow, scope, step: nextStep, ...(of ? { of } : {}), signatures: sent.map((item) => item.signature) });
    };
    try {
      for (;;) {
        lastPlan.current = { ...plan, input, index, of, earlier: [...sent] };
        const progress = (): TxStepProgress | undefined => of ? { step: index, of } : index > 1 ? { step: index } : undefined;
        const step = progress();
        if (index > MAX_TX_PLAN_STEPS) {
          setState({ status: "failed", error: laterStepFailureMessage(index, of, "this operation has more steps than expected, so nothing more was sent."), step });
          return null;
        }
        setState({ status: "preparing", step });
        let result: RunTxResult<Prepared>;
        const startedAt = Date.now();
        try {
          result = await runTx(current.adapter, input, {
            wallet: current.wallet, storage: typeof window === "undefined" ? undefined : window.localStorage,
            isCurrent: isOwner, retry, inlineFailure: latestInline.current, signal: aborter.current.signal,
            onPrepared: (prepared) => { of = plan.progress?.(prepared).of ?? of; },
            onStage: (status, detail) => { if (isOwner()) setState({ status, signature: detail?.signature, step: progress(),
              ...(detail?.secondsLeft !== undefined ? { secondsLeft: detail.secondsLeft } : {}) }); },
          });
        } catch (error) {
          if (!isOwner()) markInterrupted(index);
          if (isOwner()) {
            const failure = error instanceof TxRunError ? error : null;
            const message = failure?.message ?? "The transaction could not be completed.";
            // Before anything landed, a wallet cancel just returns the form to idle. After an earlier step landed it
            // never does: the user must see that the run stopped half-way, and Try again resumes this step.
            if (index === 1) {
              setState(failure?.kind === "rejected" ? { status: "idle" } : { status: "failed", error: message, kind: failure?.kind, retryable: failure?.retryable, step: progress() });
            } else {
              setState({ status: "failed", error: laterStepFailureMessage(index, of, message), kind: failure?.kind, step: progress(),
                retryable: !(error instanceof TxCancelCheckPendingError) && (failure?.kind === "rejected" || (failure?.retryable ?? false)) });
            }
          }
          return null;
        }
        const sentAt = Date.now();
        logStepTiming({ phase: "sent", step: index, of, via: result.via, signature: result.signature, sendMs: sentAt - startedAt });
        of = plan.progress?.(result.prepared).of ?? of;
        const following = plan.next(result, [...sent]);
        sent.push(result);
        // The last step: confirming → success / failure follows its notice, like a single send.
        if (following === null) {
          if (scope) clearTxInterruption(current.adapter.flow, scope);
          if (isOwner()) setInterrupted(null);
          return sent;
        }
        if (!isOwner()) { markInterrupted(index + 1); return null; }
        const stepNow = { step: index, of };
        setState({ status: "confirming", signature: result.signature, step: stepNow, intermediate: true });
        const status = await confirmStep(result, isOwner);
        logStepTiming({ phase: status, step: index, of, via: result.via, signature: result.signature, confirmMs: Date.now() - sentAt });
        if (!isOwner()) { markInterrupted(index + 1); return null; }
        if (status !== "confirmed") {
          setState({ status: "failed", signature: result.signature, step: stepNow, error: unconfirmedStepMessage(index, of, status),
            kind: status === "pending" ? "unknown" : status, retryable: status !== "pending" });
          // Try again restarts where this run started: the step that did not land has to be prepared again.
          lastPlan.current = start;
          return null;
        }
        input = following;
        index += 1;
      }
    } finally {
      busy.current = false;
    }
  }, [retry]);
  useLayoutEffect(() => { planRef.current = runPlan; }, [runPlan]);

  /** One send. Resolves with its result once sent (confirmation follows through the notice), or null. */
  const run = useCallback(async (input: Input) => (await runPlan({ input, index: 1, next: () => null, earlier: [] }))?.[0] ?? null, [runPlan]);
  /**
   * A multi-step operation through the same pipeline: each step is sent like `run`, and every step but the last must be
   * confirmed on Solana before the next is prepared. A step that cannot start or does not land stops the run with a
   * plain message naming the steps already on Solana; success only ever follows the last step's confirmation.
   */
  const runSteps = useCallback((first: Input, plan: TxStepPlan<Input, Prepared>) => runPlan({ ...plan, input: first, index: 1, earlier: [] }), [runPlan]);

  const reset = useCallback(() => { generation.current++; setOwned({ state: { status: "idle" } }); }, []);

  useEffect(() => {
    mounted.current = true;
    if (aborter.current.signal.aborted) aborter.current = new AbortController();
    const current = aborter.current;
    return () => { mounted.current = false; current.abort(); detachTxRetry(retry); };
  }, [retry]);

  // Wallet switch: forget the previous wallet's in-flight UI state (its notice keeps tracking).
  const state: TxPipelineState = owned.wallet === walletAddress ? owned.state : { status: "idle" };

  // Confirm stage results arrive through the shared notice store.
  const notices = useTxNotices();
  const notice = state.signature ? notices.find((item) => item.id === noticeIdFor(state.signature!)) : undefined;
  let view = state;
  if (state.status === "confirming" && !state.intermediate && notice && notice.state !== "loading") {
    view = notice.state === "success"
      ? { status: "success", signature: state.signature, kind: "landed" }
      : { status: "failed", signature: state.signature, kind: notice.kind, step: state.step,
        // The last step of a multi-step run: say that the earlier steps are on Solana.
        error: state.step && state.step.step > 1 && notice.detail ? laterStepFailureMessage(state.step.step, state.step.of, notice.detail) : notice.detail,
        retryable: notice.kind === "expired" || notice.kind === "failed" };
  }
  // The notice is only a toast: the user can dismiss it (success stays until they do). Keep the
  // settled result in this hook's own state, so the status dialog does not fall back to
  // "Confirming…" and an expired/failed run keeps its Try again once the toast is gone.
  // (Adjusting state during render, React's pattern for state derived from an external store.)
  if (view !== state && owned.state === state) setOwned({ ...owned, state: view });
  // Inline errors: a send that failed on Solana after it was sent also drops its failure toast (the panel shows it).
  const failedSignature = options.inlineErrors && owned.state.status === "failed" ? owned.state.signature : undefined;
  useEffect(() => { if (failedSignature) dismissTxNotice(noticeIdFor(failedSignature)); }, [failedSignature]);
  // Waiting for a step that is not the last to confirm is part of the run: busy until the next step starts.
  const busyNow = view.status === "preparing" || view.status === "wallet" || view.status === "checking" || view.status === "expiring" || Boolean(view.intermediate);
  // Confirming locks only while its notice is still tracking the signature (a dismissed toast must not lock the form forever).
  const locked = busyNow || (view.status === "confirming" && notice?.state === "loading");
  useLayoutEffect(() => { lockedRef.current = locked; });
  const cancelPending = useCancelCheckPending(adapter.flow, options.scope);
  return {
    ...view, run, runSteps, reset, retry,
    /** An earlier mount's multi-step run of this flow + scope stopped half-way (PR10 marker); null when none. */
    interrupted, dismissInterrupted,
    /** A cancelled send of this flow + scope is still being checked on Solana: no resubmit yet. */
    cancelPending,
    busy: busyNow,
    /** No new send and no re-quote: in flight, checking Solana after a wallet error, or confirming. */
    locked,
    closeLocked: view.status === "preparing" || view.status === "wallet",
  };
}

/**
 * Per-step send / confirm timing in the browser console, for local multi-step tests: dev builds only (`next dev`), never
 * in a production build (PM, PR10). No env flag of our own: Next.js sets NODE_ENV.
 */
export const logStepTimingEnabled = () => process.env.NODE_ENV === "development";

/** One console line per step: `sendMs` = prepare → wallet/relay returned a signature, `confirmMs` = sent → confirmed. */
export function logStepTiming(entry: { phase: string; step: number; of?: number; via?: "wallet" | "relay"; signature: string; sendMs?: number; confirmMs?: number }) {
  if (!logStepTimingEnabled()) return;
  // eslint-disable-next-line no-console -- deliberate: per-step timing for local multi-step tests (PM 2b), dev builds only
  console.info("[tx-step-timing]", JSON.stringify({ ...entry, at: new Date().toISOString() }));
}

/** Waits for a sent step that is not the last (the notice host polls the same signature for the toast). */
function confirmStep(sent: RunTxResult<PreparedTx>, isOwner: () => boolean): Promise<TxChainStatus> {
  return pollSignature({ signature: sent.signature, lastValidBlockHeight: sent.prepared.lastValidBlockHeight, isCancelled: () => !isOwner() });
}
