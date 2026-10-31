"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  detachTxRetry, noticeIdFor, runTx, TxRunError, useTxNotices,
  type PreparedTx, type TxAdapter, type TxFailureKind, type TxStage, type TxWallet,
} from "@/lib/tx-pipeline";

export type TxPipelineStatus = "idle" | TxStage | "success" | "failed";
export type TxPipelineState = {
  status: TxPipelineStatus; signature?: string; error?: string; kind?: TxFailureKind | "landed"; retryable?: boolean;
};

/**
 * React binding for the shared pipeline. A flow passes its adapter and gets back a stage,
 * a plain error, a one-tap retry, `closeLocked` (true while preparing or in the wallet,
 * so a stray backdrop click cannot abandon a signature request) and `locked` (also true while
 * checking Solana after a wallet error and while confirming: no second send, no re-quote).
 */
export function useTxPipeline<Input, Prepared extends PreparedTx>(adapter: TxAdapter<Input, Prepared>, wallet: TxWallet | null) {
  const [owned, setOwned] = useState<{ wallet?: string; state: TxPipelineState }>({ state: { status: "idle" } });
  const generation = useRef(0);
  const mounted = useRef(true);
  const busy = useRef(false);
  const lockedRef = useRef(false);
  const lastInput = useRef<{ value: Input } | null>(null);
  const latest = useRef({ adapter, wallet });
  useLayoutEffect(() => { latest.current = { adapter, wallet }; });
  const runRef = useRef<(input: Input) => Promise<unknown>>(async () => null);
  const retry = useCallback(() => { if (lastInput.current && !busy.current) void runRef.current(lastInput.current.value); }, []);
  const walletAddress = wallet?.address;

  const run = useCallback(async (input: Input) => {
    const current = latest.current;
    if (busy.current || lockedRef.current || !current.wallet) return null;
    const own = ++generation.current;
    const submittedWallet = current.wallet.address;
    const isOwner = () => mounted.current && generation.current === own && latest.current.wallet?.address === submittedWallet;
    busy.current = true;
    lastInput.current = { value: input };
    const setState = (state: TxPipelineState) => setOwned({ wallet: submittedWallet, state });
    setState({ status: "preparing" });
    try {
      const result = await runTx(current.adapter, input, {
        wallet: current.wallet, storage: typeof window === "undefined" ? undefined : window.localStorage,
        isCurrent: isOwner, retry,
        onStage: (status, detail) => { if (isOwner()) setState({ status, signature: detail?.signature }); },
      });
      return result;
    } catch (error) {
      if (isOwner()) {
        const failure = error instanceof TxRunError ? error : null;
        setState(failure?.kind === "rejected" ? { status: "idle" } : {
          status: "failed", error: failure?.message ?? "The transaction could not be completed.",
          kind: failure?.kind, retryable: failure?.retryable,
        });
      }
      return null;
    } finally {
      busy.current = false;
    }
  }, [retry]);
  useLayoutEffect(() => { runRef.current = run; }, [run]);

  const reset = useCallback(() => { generation.current++; setOwned({ state: { status: "idle" } }); }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; detachTxRetry(retry); };
  }, [retry]);

  // Wallet switch: forget the previous wallet's in-flight UI state (its notice keeps tracking).
  const state: TxPipelineState = owned.wallet === walletAddress ? owned.state : { status: "idle" };

  // Confirm stage results arrive through the shared notice store.
  const notices = useTxNotices();
  const notice = state.signature ? notices.find((item) => item.id === noticeIdFor(state.signature!)) : undefined;
  let view = state;
  if (state.status === "confirming" && notice && notice.state !== "loading") {
    view = notice.state === "success"
      ? { status: "success", signature: state.signature, kind: "landed" }
      : { status: "failed", signature: state.signature, error: notice.detail, kind: notice.kind,
        retryable: notice.kind === "expired" || notice.kind === "failed" };
  }
  // The notice is only a toast: it auto-closes after success and the user can dismiss it. Keep the
  // settled result in this hook's own state, so the status dialog does not fall back to
  // "Confirming…" and an expired/failed run keeps its Try again once the toast is gone.
  // (Adjusting state during render, React's pattern for state derived from an external store.)
  if (view !== state && owned.state === state) setOwned({ ...owned, state: view });
  const busyNow = view.status === "preparing" || view.status === "wallet" || view.status === "checking";
  // Confirming locks only while its notice is still tracking the signature (a dismissed toast must not lock the form forever).
  const locked = busyNow || (view.status === "confirming" && notice?.state === "loading");
  useLayoutEffect(() => { lockedRef.current = locked; });
  return {
    ...view, run, reset, retry,
    busy: busyNow,
    /** No new send and no re-quote: in flight, checking Solana after a wallet error, or confirming. */
    locked,
    closeLocked: view.status === "preparing" || view.status === "wallet",
  };
}
