"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { clientOpenDiag } from "@/lib/open-diag-client";
import type { OpenPositionQuote } from "@sofinance/engine/open-types";
import type { OpenRangePreset } from "@sofinance/engine/open-range-presets";
import type { WalletAsset } from "@sofinance/engine/wallet-discovery";
import { jupiterRelayEnabled, jupiterRelayFailureMessage, postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";

type ApiError = { error: string };
type OpenPreviewOptions = {
  wallet?: string;
  pair: { poolAddress: string } | null;
  inputMint: string | null;
  inputKind: "native" | "token";
  amount: string;
  rangePreset: OpenRangePreset;
  minPrice: string;
  maxPrice: string;
  selectedAsset: WalletAsset | null;
  parsedAmount: bigint | null;
  formError: string;
  busy: boolean;
  // Keep the complete stage dependency: transitions other than confirmed also restart the reader.
  submitStage: string | null;
  walletRef: RefObject<string | undefined>;
  // The facade owns the one per-modal store shared with prepare, and the one clock.
  jupiterStoreRef: RefObject<JupiterRelayStore>;
  setNow: (now: number) => void;
};

/** Background quote polling pauses this long after a failed refresh. */
export const QUOTE_ERROR_POLL_PAUSE_MS = 30_000;
/** Server-keyed polling interval (relay disabled). */
export const QUOTE_POLL_MS = 3_000;
/**
 * Browser-quoted polling interval. Jupiter's keyless quota is ~5 requests / 10 s
 * per IP and an open preview costs 2-4 quotes, so poll well under that.
 */
export const RELAY_QUOTE_POLL_MS = 15_000;
/** Hard cap so quote cannot spin past a Jupiter 429 wait with no UI error. */
export const OPEN_QUOTE_TIMEOUT_MS = 45_000;

/** State only: registering the reader separately preserves the facade's effect order. */
export function useOpenPreview() {
  const [quote, setQuote] = useState<OpenPositionQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteRevision, setQuoteRevision] = useState(0);
  const quoteRequestRef = useRef(0);
  const invalidateQuote = useCallback(() => { quoteRequestRef.current += 1; }, []);

  const start = useCallback(({ pair, wallet, inputMint, selectedAsset, busy, submitStage,
    parsedAmount, formError, inputKind, amount, rangePreset, minPrice, maxPrice,
    walletRef, jupiterStoreRef, setNow }: OpenPreviewOptions) => {
    if (!pair || !wallet || !inputMint || !selectedAsset?.eligible || busy || submitStage === "confirmed") return;
    if (parsedAmount === null || formError) return;
    const raw = parsedAmount;
    const requestId = ++quoteRequestRef.current;
    const aborter = new AbortController();
    let pollTimer: number | undefined;
    let inFlight = false;
    // Background refreshes skip hidden tabs and pause after a failure: every quote spends shared
    // server-side Jupiter quota. The explicit "Refresh quote" action restarts this effect at once.
    let pausedUntil = 0;
    let onVisible: (() => void) | undefined;
    const currentRequest = () => requestId === quoteRequestRef.current &&
      !aborter.signal.aborted && walletRef.current === wallet;
    const timer = window.setTimeout(() => {
      const load = async () => {
        if (inFlight || !currentRequest()) return;
        inFlight = true;
        setQuoteLoading(true);
        setQuoteError("");
        try {
          const timeout = AbortSignal.timeout(OPEN_QUOTE_TIMEOUT_MS);
          const signal = typeof AbortSignal.any === "function" ? AbortSignal.any([aborter.signal, timeout]) : aborter.signal;
          const response = await postWithJupiterRelay("/api/open-quote", {
            wallet, poolId: pair.poolAddress, inputMint, inputKind, amount,
            rangePreset, minPrice, maxPrice, diag: clientOpenDiag(),
          }, { store: jupiterStoreRef.current, signal });
          const data = await response.json() as OpenPositionQuote | ApiError;
          if (!currentRequest()) return;
          if (!response.ok) throw new Error((data as ApiError).error);
          const current = data as OpenPositionQuote;
          if (current.requested !== raw.toString()) throw new Error("Quote and current input mismatch, please re-enter amount");
          setQuote(current);
          setNow(Date.now());
        } catch (caught) {
          if (currentRequest()) {
            pausedUntil = Date.now() + QUOTE_ERROR_POLL_PAUSE_MS;
            setQuote(null);
            setQuoteError(jupiterRelayFailureMessage(caught, "Quote timed out. Please retry."));
          }
        } finally {
          inFlight = false;
          if (currentRequest()) setQuoteLoading(false);
        }
      };
      const poll = () => {
        if (document.hidden || Date.now() < pausedUntil) return;
        void load();
      };
      pollTimer = window.setInterval(poll, jupiterRelayEnabled() ? RELAY_QUOTE_POLL_MS : QUOTE_POLL_MS);
      onVisible = () => { if (!document.hidden) poll(); };
      document.addEventListener("visibilitychange", onVisible);
      void load();
    }, 450);
    return () => {
      aborter.abort();
      window.clearTimeout(timer);
      if (pollTimer !== undefined) window.clearInterval(pollTimer);
      if (onVisible) document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Raw setters intentionally do not invalidate: prepare adoption and submission loading
  // retain their original timing. clearQuote sequences these ports in the facade.
  return { quote, setQuote, quoteLoading, setQuoteLoading, quoteError, setQuoteError,
    quoteRevision, setQuoteRevision, invalidateQuote, start };
}

/** Register after the facade clock and wallet discovery, at the original quote effect site. */
export function useOpenPreviewEffect(
  { amount, busy, formError, inputKind, inputMint, maxPrice, minPrice, pair, parsedAmount,
    rangePreset, selectedAsset, submitStage, wallet, walletRef, jupiterStoreRef, setNow }: OpenPreviewOptions,
  { start, quoteRevision }: Pick<ReturnType<typeof useOpenPreview>, "start" | "quoteRevision">,
) {
  useEffect(() => start({ amount, busy, formError, inputKind, inputMint, maxPrice, minPrice,
    pair, parsedAmount, rangePreset, selectedAsset, submitStage, wallet, walletRef, jupiterStoreRef, setNow }),
  [amount, busy, formError, inputKind, inputMint, maxPrice, minPrice, pair, parsedAmount,
    quoteRevision, rangePreset, selectedAsset, submitStage, wallet, walletRef, jupiterStoreRef, setNow, start]);
}
