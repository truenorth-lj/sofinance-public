"use client";
import "@/lib/engine-host";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { quoteIsFresh } from "@sofinance/engine/quote-math";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { NO_BEAM_STATUS } from "@/lib/open-beam-status";
import type { WalletAsset, WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { useWalletConnection } from "./wallet-connection";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import { useOpenAttempt } from "./use-open-attempt";
import { captureGrowthEventOnce } from "@/lib/analytics/client";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";

import { useOpenPreview, useOpenPreviewEffect } from "./transactions/open/use-open-preview";
import { useOpenSubmission, useOpenSubmissionCommand, type OpenSubmitStage } from "./transactions/open/use-open-submission";

export type OpenPositionPair = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
  wrappedSymbol: string;
  plainSymbol: string;
  feeTierBps: number | null;
  token2022A: boolean;
  token2022B: boolean;
  freezeRisk: boolean;
};

type ApiError = { error: string };
export type { OpenSubmitStage } from "./transactions/open/use-open-submission";

function pickInput(assets: WalletAsset[], mintA: string, mintB: string): WalletAsset | null {
  const eligible = assets.filter((item) => item.eligible);
  const preferred = [USDC_MINT, NATIVE_SOL_MINT, mintA, mintB];
  for (const mint of preferred) {
    const found = eligible.find((item) => item.mint === mint);
    if (found) return found;
  }
  return eligible.find((item) => item.mint === mintA || item.mint === mintB || item.mint === NATIVE_SOL_MINT || item.mint === USDC_MINT) ?? null;
}

export { QUOTE_ERROR_POLL_PAUSE_MS, QUOTE_POLL_MS, RELAY_QUOTE_POLL_MS, OPEN_QUOTE_TIMEOUT_MS } from "./transactions/open/use-open-preview";
export { OPEN_PREPARE_TIMEOUT_MS } from "./transactions/open/use-open-submission";

export function useOpenPositionController(pair: OpenPositionPair | null) {
  const { address: wallet, connected, connect, signTransaction } = useWalletConnection();
  const open = useOpenAttempt(wallet);
  const confirmedMint = open.status === "confirmed" ? open.attempt?.nftMint ?? null : null;
  useEffect(() => {
    if (confirmedMint) notifyPositionHistoryChange(confirmedMint);
  }, [confirmedMint]);
  useEffect(() => {
    const attempt = open.attempt;
    if (!attempt) return;
    const properties = openEventProperties(pair);
    if (open.status === "confirmed") {
      captureGrowthEventOnce(`open-ok:${attempt.signature}`, GROWTH_EVENTS.openSuccess, properties);
    } else if (open.status === "failed" || open.status === "expired") {
      captureGrowthEventOnce(`open-fail:${attempt.signature}`, GROWTH_EVENTS.openFailed, {
        ...properties,
        error_class: open.status === "expired" ? "expired" : "onchain_failed",
      });
    }
  }, [open.attempt, open.status, pair]);
  const [discovery, setDiscovery] = useState<WalletDiscovery | null>(null);
  const [inputMint, setInputMint] = useState<string | null>(null);
  const [inputKind, setInputKind] = useState<"native" | "token">("token");
  const [amount, setAmount] = useState("");
  const [rangePreset, setRangePreset] = useState<OpenRangePreset>("standard");
  const [minPrice, setMinPrice] = useState("");
  const [maxPrice, setMaxPrice] = useState("");
  const preview = useOpenPreview();
  const { quote, setQuote, quoteLoading, setQuoteLoading, quoteError, setQuoteError,
    setQuoteRevision, invalidateQuote } = preview;
  const submission = useOpenSubmission();
  const { operationStage, beamResult } = submission;
  // Discovery and submission share this error; form commands clear it synchronously.
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const jupiterStoreRef = useRef(createJupiterRelayStore());
  const activeRef = useRef(false);
  useLayoutEffect(() => { activeRef.current = true; return () => { activeRef.current = false; }; }, []);
  const identity = JSON.stringify([wallet, pair?.poolAddress, inputMint, inputKind, amount, rangePreset, minPrice, maxPrice]);
  const identityRef = useRef(identity);
  useLayoutEffect(() => { walletRef.current = wallet; identityRef.current = identity; }, [wallet, identity]);
  const samePool = open.attempt?.poolId === pair?.poolAddress;
  const submitStage: OpenSubmitStage = operationStage ?? (open.pending && open.loaded ? "pending"
    : samePool && open.status !== "unsent" ? open.status : null);
  const signature = open.status ? open.attempt?.signature ?? "" : "";
  const positionMint = samePool ? open.attempt?.nftMint ?? "" : "";

  const inputAssets = useMemo(() => {
    if (!discovery || !pair) return [];
    const allowed = new Set([NATIVE_SOL_MINT, USDC_MINT, pair.mintA, pair.mintB]);
    return discovery.assets.filter((item) => allowed.has(item.mint));
  }, [discovery, pair]);

  const selectedAsset = inputAssets.find((item) => item.mint === inputMint && item.kind === inputKind) ?? null;
  const fresh = quote ? quoteIsFresh(quote.expiresAt, now) : false;
  const busy = operationStage === "preparing" || operationStage === "wallet" || operationStage === "broadcasting" || open.pending;
  let parsedAmount: bigint | null = null;
  if (selectedAsset?.eligible && amount) {
    try {
      parsedAmount = parseTokenAmount(amount, selectedAsset.decimals);
    } catch {
      parsedAmount = null;
    }
  }
  const formError = amount && selectedAsset && parsedAmount === null
    ? "Enter a valid amount"
    : rangePreset === "custom" && (!minPrice || !maxPrice)
      ? "Enter a custom min and max price (B per 1 A)"
      : "";

  useEffect(() => {
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!wallet) {
      const timer = window.setTimeout(() => {
        setDiscovery(null);
        setInputMint(null);
      }, 0);
      return () => window.clearTimeout(timer);
    }
    const aborter = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/wallet?wallet=${encodeURIComponent(wallet)}`, {
            cache: "no-store", signal: aborter.signal,
          });
          const data = await response.json() as WalletDiscovery | ApiError;
          if (!response.ok) throw new Error((data as ApiError).error);
          if (walletRef.current !== wallet) return;
          const found = data as WalletDiscovery;
          setDiscovery(found);
          const pick = pair ? pickInput(found.assets, pair.mintA, pair.mintB) : null;
          if (pick) {
            setInputMint(pick.mint);
            setInputKind(pick.kind);
          }
        } catch (caught) {
          if (!aborter.signal.aborted) {
            setDiscovery(null);
            setError(caught instanceof Error ? caught.message : "Wallet scan failed");
          }
        }
      })();
    }, 0);
    return () => {
      aborter.abort();
      window.clearTimeout(timer);
    };
  }, [wallet, pair]);

  useOpenPreviewEffect({ amount, busy, formError, inputKind, inputMint, maxPrice, minPrice,
    pair, parsedAmount, rangePreset, selectedAsset, submitStage, wallet, walletRef, jupiterStoreRef, setNow }, preview);

  const clearQuote = () => {
    invalidateQuote();
    // Same-value commands and batched A→B→A still need a replacement reader.
    setQuoteRevision((revision) => revision + 1);
    setQuote(null);
    setQuoteLoading(false);
    setError("");
    setQuoteError("");
  };

  const changeAmount = (value: string) => {
    clearQuote();
    setAmount(value);
  };

  const chooseAsset = (kind: "native" | "token", mint: string) => {
    clearQuote();
    setInputKind(kind);
    setInputMint(mint);
  };

  const choosePreset = (preset: OpenRangePreset) => {
    clearQuote();
    setRangePreset(preset);
  };

  const changeMinPrice = (value: string) => { clearQuote(); setMinPrice(value); };
  const changeMaxPrice = (value: string) => { clearQuote(); setMaxPrice(value); };
  const canRefreshQuote = !busy && submitStage !== "confirmed" && Boolean(pair && wallet && inputMint &&
    selectedAsset?.eligible && parsedAmount !== null && !formError);
  const refreshQuote = () => {
    if (!canRefreshQuote || quoteLoading) return;
    clearQuote();
  };

  const fillMax = () => {
    if (!selectedAsset) return;
    changeAmount(formatAmount(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals));
  };

  const signAndSend = useOpenSubmissionCommand({ pair, wallet, inputMint, inputKind, amount, rangePreset,
    minPrice, maxPrice, parsedAmount, quote, fresh, busy, identity, open, signTransaction,
    activeRef, walletRef, identityRef, jupiterStoreRef, setError, setNow, setQuote, setQuoteLoading }, submission);

  const walletBlockedReason = !connected
    ? "Connect a wallet to create a position"
    : !selectedAsset
      ? "No eligible SOL, USDC, or pool token in this wallet"
      : selectedAsset && !selectedAsset.eligible
        ? (selectedAsset.reason || "Selected asset is not eligible")
        : null;

  const actionBlockedReason = open.pending ? "Checking the original open-position transaction before opening again"
    : walletBlockedReason || formError ||
    (quoteLoading && (!quote || !fresh) ? "Fetching quote…"
      : quoteError ? quoteError
        : parsedAmount === null ? "Enter an amount to get a quote"
          : !quote ? "Waiting for quote…"
            : !fresh ? "Quote expired, refreshing…"
              : null);
  const actionDisabled = busy || Boolean(actionBlockedReason);

  return {
    wallet, connected, connect, inputAssets, selectedAsset, inputMint, inputKind,
    amount, rangePreset, minPrice, maxPrice, quote, quoteLoading, quoteError: formError || quoteError,
    error: open.error || (open.status === "confirmed" ? "" : error),
    submitStage, signature, positionMint,
    beamStatus: open.status === "confirmed" && beamResult?.signature === signature ? beamResult.status : NO_BEAM_STATUS, presets: OPEN_RANGE_UI_PRESETS, fresh, busy,
    actionDisabled, actionBlockedReason, walletBlockedReason, changeAmount, chooseAsset, choosePreset,
    setMinPrice: changeMinPrice, setMaxPrice: changeMaxPrice, fillMax, signAndSend,
    now, refreshQuote, canRefreshQuote, retryConfirmation: open.retry,
    createAnother: () => { if (!busy) { open.dismissTerminal(); clearQuote(); } },
  };
}
