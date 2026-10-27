"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PositionSelection } from "@sofinance/engine/selected-state";
import type { SelectedQuote } from "@/lib/selected-quote";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { quoteErrorHidesRecalculate } from "@/lib/selected-amount-error";
import { RELAY_DEADLINE_MS, selectionKey, type Preflight, type Preview } from "./selected-preview-model";

type ApiError = { error: string; code?: string; outputMint?: string };
type SelectedPreviewOptions = {
  wallet?: string;
  selection: PositionSelection | null;
  amount: string;
  rawAmount: bigint;
  floorBps: number;
  toleranceBps: number | null;
  ready: boolean | null;
  busy: boolean;
  // Owned by the panel and shared with explicit prepare, never a second cache.
  getRelayStore: () => JupiterRelayStore;
  // Stable facade ports preserve its wallet/selection effect ordering and single clock.
  isCurrent: (wallet: string, selectionKey: string) => boolean;
  setNow: (now: number) => void;
};

/** Preview state and explicit commands; effect registration is kept at its original position. */
export function useSelectedPreview() {
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });
  const [quoteError, setQuoteError] = useState("");
  const [quoteErrorCode, setQuoteErrorCode] = useState("");
  const [quoteErrorOutputMint, setQuoteErrorOutputMint] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const quoteRequestRef = useRef(0);

  // Invalidating ownership is synchronous and intentionally separate from clearing UI.
  const invalidate = useCallback(() => { quoteRequestRef.current++; }, []);
  const clear = useCallback(() => { setPreview({ kind: "idle" }); }, []);
  const clearErrors = useCallback(() => {
    setQuoteError(""); setQuoteErrorCode(""); setQuoteErrorOutputMint("");
  }, []);
  const adopt = useCallback((result: Preflight) => { setPreview({ kind: "quoted", result }); }, []);
  const retryCalculation = () => {
    setQuoteError(""); setQuoteErrorCode(""); setQuoteErrorOutputMint(""); setPreview({ kind: "idle" });
    setQuoteRevision((current) => current + 1);
  };

  const start = useCallback(({ wallet, selection, amount, rawAmount, floorBps, toleranceBps,
    ready, busy, getRelayStore, isCurrent, setNow }: SelectedPreviewOptions) => {
    if (!ready || !wallet || !selection || toleranceBps === null || busy) return;
    const requestId = ++quoteRequestRef.current;
    const aborter = new AbortController();
    let cancelled = false;
    const key = selectionKey(selection);
    const requested = rawAmount.toString();
    let expiryTimer: number | undefined;
    let deadline: number | undefined;
    let onVisible: (() => void) | undefined;
    const scheduleRefresh = (expiresAt: number) => {
      expiryTimer = window.setTimeout(() => {
        // A hidden tab does not need a live preview (each one costs shared Jupiter quota): refresh on return.
        if (!document.hidden) { setQuoteRevision((current) => current + 1); return; }
        onVisible = () => { if (!document.hidden) setQuoteRevision((current) => current + 1); };
        document.addEventListener("visibilitychange", onVisible);
      }, Math.max(1_000, expiresAt - Date.now()));
    };
    const current = () => !cancelled && requestId === quoteRequestRef.current &&
      isCurrent(wallet, key);
    const timer = window.setTimeout(() => {
      const load = async () => {
        setQuoteLoading(true); setPreview({ kind: "idle" }); setQuoteError(""); setQuoteErrorCode(""); setQuoteErrorOutputMint("");
        deadline = window.setTimeout(() => aborter.abort(new Error("Preview took too long. Please retry.")), RELAY_DEADLINE_MS);
        try {
          const response = await postWithJupiterRelay("/api/selected-quote", { wallet, ...selection, amount, floorBps, toleranceBps },
            { store: getRelayStore(), signal: aborter.signal });
          const data = await response.json() as SelectedQuote | ApiError;
          if (!current() || aborter.signal.aborted) return;
          if (!response.ok) {
            const failed = data as ApiError;
            const failure = new Error(failed.error);
            (failure as Error & { code?: string; outputMint?: string }).code = failed.code;
            (failure as Error & { code?: string; outputMint?: string }).outputMint = failed.outputMint;
            throw failure;
          }
          const currentQuote = data as SelectedQuote;
          if (currentQuote.wallet !== wallet || selectionKey(currentQuote) !== key ||
            currentQuote.requested !== requested || currentQuote.floorBps !== floorBps ||
            currentQuote.toleranceBps !== toleranceBps) {
            throw new Error("Quote and current input mismatch, please re-enter amount");
          }
          setPreview({ kind: "quoted", result: { quote: currentQuote, simulated: false } });
          setNow(Date.now());
          scheduleRefresh(currentQuote.expiresAt);
        } catch (caught) {
          if (current()) {
            setQuoteError(aborter.signal.aborted ? "Preview took too long. Please retry." :
              caught instanceof Error ? caught.message : "Preview failed");
            const code = caught instanceof Error ? (caught as Error & { code?: string }).code : undefined;
            const outputMint = caught instanceof Error ? (caught as Error & { outputMint?: string }).outputMint : undefined;
            setQuoteErrorCode(aborter.signal.aborted ? "" : code ?? "");
            setQuoteErrorOutputMint(aborter.signal.aborted ? "" : outputMint ?? "");
          }
        } finally {
          window.clearTimeout(deadline);
          if (current()) setQuoteLoading(false);
        }
      };
      void load();
    }, 450);
    return () => {
      cancelled = true; aborter.abort(); window.clearTimeout(timer); window.clearTimeout(deadline);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  const showQuoteRecalculate = Boolean(quoteError) && !quoteErrorHidesRecalculate(quoteErrorCode);
  return { preview, quoteError, quoteErrorCode, quoteErrorOutputMint, quoteLoading,
    invalidate, clear, clearErrors, adopt, retryCalculation, showQuoteRecalculate,
    quoteRevision, start };
}

/**
 * Register after the facade wallet/selection resets, discovery, clock and history effects.
 * The two hooks keep synchronous invalidation available before those effects without
 * moving the quote effect ahead of them. Only preview-owned setup/revision cross here.
 */
export function useSelectedPreviewEffect(
  { wallet, selection, amount, rawAmount, floorBps, toleranceBps, ready, busy,
    getRelayStore, isCurrent, setNow }: SelectedPreviewOptions,
  { start, quoteRevision }: Pick<ReturnType<typeof useSelectedPreview>, "start" | "quoteRevision">,
) {
  useEffect(() => start({ wallet, selection, amount, rawAmount, floorBps, toleranceBps, ready, busy,
    getRelayStore, isCurrent, setNow }),
  [amount, busy, floorBps, toleranceBps, quoteRevision, rawAmount, ready, selection, wallet,
    getRelayStore, isCurrent, setNow, start]);
}
