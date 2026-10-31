"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { quoteIsFresh } from "@sofinance/engine/quote-math";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import type { WalletAsset, WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { useWalletConnection } from "./wallet-connection";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import { BALANCES_REFRESH_EVENT, CANCEL_CHECK_PENDING_COPY, useCancelCheckPending } from "@/lib/tx-pipeline";
import { useOpenAttempt } from "./use-open-attempt";
import { captureGrowthEventOnce } from "@/lib/analytics/client";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";
import { openOutcomeFailureProperties } from "@/lib/analytics/errors";
import { SOL_INPUT_DISABLED_MESSAGE } from "@/lib/feature-flags";
import { applySolInputPolicy, isSolInputBlocked } from "@/lib/sol-input-policy";

import { useOpenPreview, useOpenPreviewEffect } from "./transactions/open/use-open-preview";
import { useOpenSubmission, useOpenSubmissionCommand, type OpenSubmitStage } from "./transactions/open/use-open-submission";
import { useSolSwapRecovery } from "./transactions/open/use-sol-swap-recovery";
import { clearWalletSolSwapReceipts, isSolSwapReceiptExpired, loadSolSwapReceipt,
  receiptStorage } from "./transactions/open/sol-swap-receipt-store";

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
  const { address: wallet, connected, connect, signTransaction, signAndSendTransaction } = useWalletConnection();
  const txWallet = useMemo(() => ({ address: wallet ?? "", signTransaction, signAndSendTransaction }),
    [wallet, signTransaction, signAndSendTransaction]);
  const open = useOpenAttempt(wallet);
  const confirmedMint = open.status === "confirmed" ? open.attempt?.nftMint ?? null : null;
  useEffect(() => {
    if (confirmedMint) notifyPositionHistoryChange(confirmedMint);
  }, [confirmedMint]);
  useEffect(() => {
    const attempt = open.attempt;
    if (!attempt) return;
    const properties = openEventProperties(pair, { wallet });
    if (open.status === "confirmed") {
      captureGrowthEventOnce(`open-ok:${attempt.signature}`, GROWTH_EVENTS.openSuccess, properties);
    } else if (open.status === "failed" || open.status === "expired") {
      captureGrowthEventOnce(`open-fail:${attempt.signature}`, GROWTH_EVENTS.openFailed, {
        ...properties,
        ...openOutcomeFailureProperties(open.status),
      });
    }
  }, [open.attempt, open.status, pair, wallet]);
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
  const { operationStage, openStep, swapReceipt, setSwapReceipt } = submission;
  // Discovery and submission share this error; form commands clear it synchronously.
  const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const jupiterStoreRef = useRef(createJupiterRelayStore());
  const activeRef = useRef(false);
  const lifetimeRef = useRef(0);
  const identityKey = JSON.stringify([wallet, pair?.poolAddress, inputMint, inputKind, amount, rangePreset, minPrice, maxPrice]);
  // Each committed A→B→A has a distinct token; speculative renders never publish it.
  const identity = useMemo(() => ({ key: identityKey, connected }), [identityKey, connected]);
  const identityRef = useRef(identity);
  useLayoutEffect(() => {
    activeRef.current = connected;
    walletRef.current = wallet;
    identityRef.current = identity;
    return () => {
      activeRef.current = false;
      // Cleanup runs for committed identity changes and retained-tree disconnects.
      // Never publish speculative render values into these shared refs.
      lifetimeRef.current += 1;
    };
  }, [connected, wallet, identity]);
  const samePool = open.attempt?.poolId === pair?.poolAddress;
  const submitStage: OpenSubmitStage = operationStage ?? (open.pending && open.loaded ? "pending"
    : samePool && open.status !== "unsent" ? open.status : null);
  const retryRef = useRef<() => void>(() => {});
  const retryOpen = useCallback(() => retryRef.current(), []);
  const signature = open.status ? open.attempt?.signature ?? "" : "";
  const positionMint = samePool ? open.attempt?.nftMint ?? "" : "";

  const inputAssets = useMemo(() => {
    if (!discovery || !pair) return [];
    const allowed = new Set([NATIVE_SOL_MINT, USDC_MINT, pair.mintA, pair.mintB]);
    return applySolInputPolicy(discovery.assets.filter((item) => allowed.has(item.mint)));
  }, [discovery, pair]);

  const selectedAsset = inputAssets.find((item) => item.mint === inputMint && item.kind === inputKind) ?? null;
  const fresh = quote ? quoteIsFresh(quote.expiresAt, now) : false;
  // "checking" / "swap-checking": the wallet threw and we are looking for the transaction on-chain; nothing may be resent.
  const busy = operationStage === "preparing" || operationStage === "wallet" || operationStage === "checking" || operationStage === "broadcasting" ||
    operationStage === "swap-preparing" || operationStage === "swap-wallet" || operationStage === "swap-checking" || operationStage === "swap-broadcasting" ||
    operationStage === "swap-pending" || open.pending;
  const swapRecovery = useSolSwapRecovery({ wallet, connected, blocked: busy, onReceipt: (receipt) => {
    if (receipt.wallet === wallet && receipt.poolId === pair?.poolAddress) setSwapReceipt(receipt, { persist: false });
  } });
  // Step 1/2 landed for this wallet + pool but its open has not confirmed: offer "Continue open (2/2)".
  const pendingSwap = swapReceipt && swapReceipt.wallet === wallet && swapReceipt.poolId === pair?.poolAddress &&
    !(now > 0 && isSolSwapReceiptExpired(swapReceipt, now)) ? swapReceipt : null;
  const poolAddress = pair?.poolAddress;
  const lastWalletRef = useRef<string | undefined>(undefined);
  const { submittingRef } = submission;
  useEffect(() => {
    // Hydrate the persisted step 1/2 receipt for this wallet + pool (survives input edits, modal close, reload).
    // A switch to a different wallet drops the previous wallet's receipts; a transient disconnect does not.
    const previous = lastWalletRef.current;
    if (wallet) lastWalletRef.current = wallet;
    const timer = window.setTimeout(() => {
      const storage = receiptStorage();
      if (storage && wallet && previous && previous !== wallet) clearWalletSolSwapReceipts(storage, previous);
      if (submittingRef.current) return;
      const loaded = storage && wallet && poolAddress ? loadSolSwapReceipt(storage, wallet, poolAddress, Date.now()) : null;
      setSwapReceipt(loaded, { persist: false });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet, poolAddress, setSwapReceipt, submittingRef]);
  useEffect(() => {
    if (!swapReceipt) return;
    // The two-step deposit is complete once ITS step-2 open confirms; the receipt also lapses with the fee credit.
    const consumed = open.status === "confirmed" && Boolean(swapReceipt.openSignature) &&
      open.attempt?.signature === swapReceipt.openSignature;
    if (consumed || (now > 0 && isSolSwapReceiptExpired(swapReceipt, now))) setSwapReceipt(null);
  }, [open.status, open.attempt?.signature, swapReceipt, setSwapReceipt, now]);
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
          const pick = pair ? pickInput(applySolInputPolicy(found.assets), pair.mintA, pair.mintB) : null;
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

  // A transaction notice finished (possibly after this modal's own send): re-read balances only.
  useEffect(() => {
    if (!wallet) return;
    const refresh = () => {
      void fetch(`/api/wallet?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" })
        .then(async (response) => response.ok ? await response.json() as WalletDiscovery : null)
        .then((found) => { if (found && walletRef.current === wallet) setDiscovery(found); })
        .catch(() => { /* The previous balances stay visible. */ });
    };
    window.addEventListener(BALANCES_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(BALANCES_REFRESH_EVENT, refresh);
  }, [wallet]);

  useOpenPreviewEffect({ amount, busy, formError, inputKind, inputMint, maxPrice, minPrice,
    pair, parsedAmount, rangePreset, selectedAsset, submitStage, wallet, walletRef, jupiterStoreRef, setNow }, preview);

  const clearQuote = () => {
    submission.invalidateSubmission();
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
    minPrice, maxPrice, parsedAmount, quote, fresh, busy, identity, open, txWallet, retry: retryOpen,
    activeRef, walletRef, identityRef, lifetimeRef, jupiterStoreRef, setError, setNow, setQuote, setQuoteLoading }, submission);
  useEffect(() => { retryRef.current = () => { void signAndSend(); }; }, [signAndSend]);

  const walletBlockedReason = !connected
    ? "Connect a wallet to create a position"
    : !selectedAsset
      ? (inputAssets.some((item) => isSolInputBlocked(item.kind)) && !inputAssets.some((item) => item.eligible)
        ? SOL_INPUT_DISABLED_MESSAGE
        : "No eligible SOL, USDC, or pool token in this wallet")
      : selectedAsset && !selectedAsset.eligible
        ? (selectedAsset.reason || "Selected asset is not eligible")
        : null;

  // A cancelled open (or its SOL swap step) on this pool is still being checked on Solana: no second one yet.
  const cancelPending = useCancelCheckPending("open", pair?.poolAddress);
  const actionBlockedReason = swapRecovery.invalid ? swapRecovery.error
    : cancelPending ? CANCEL_CHECK_PENDING_COPY
    : swapRecovery.attempt ? "Check the original SOL swap before opening again"
    : open.pending ? "Checking the original open-position transaction before opening again"
    : pendingSwap ? (!connected ? "Connect a wallet to create a position" : rangePreset === "custom" && (!minPrice || !maxPrice) ? formError : null)
    : walletBlockedReason || formError ||
    (quoteLoading && (!quote || !fresh) ? "Fetching quote…"
      : quoteError ? quoteError
        : parsedAmount === null ? "Enter an amount to get a quote"
          : !quote ? "Waiting for quote…"
            : !fresh ? "Quote expired, refreshing…"
              : null);
  const actionDisabled = busy || swapRecovery.checking || Boolean(actionBlockedReason);
  // Signing or sending is in progress: closing now would hide the result, so the modal stays open.
  const closeLocked = operationStage === "preparing" || operationStage === "wallet" || operationStage === "broadcasting" ||
    operationStage === "swap-preparing" || operationStage === "swap-wallet" || operationStage === "swap-broadcasting";
  // Keep retry admission/preparation errors separate from errors awaiting chain verification.
  const retryError = (open.status === "failed" || open.status === "expired") &&
    submission.retryError?.signature === open.attempt?.signature ? submission.retryError?.message : "";

  return {
    wallet, connected, connect, inputAssets, selectedAsset, inputMint, inputKind,
    amount, rangePreset, minPrice, maxPrice, quote, quoteLoading, quoteError: formError || quoteError,
    error: swapRecovery.error || retryError || open.error || (open.status === "confirmed" ? "" : error),
    submitStage, signature, positionMint, openStep, pendingSwap,
    unconfirmedSwap: swapRecovery.attempt, checkingSwap: swapRecovery.checking,
    recheckSwap: swapRecovery.recheck,
    solTwoStep: inputKind === "native" || Boolean(pendingSwap),
    presets: OPEN_RANGE_UI_PRESETS, fresh, busy, closeLocked, reprepare: (submission.reprepare || (samePool && (open.status === "expired" || open.status === "failed"))) && !busy,
    actionDisabled, actionBlockedReason, walletBlockedReason, changeAmount, chooseAsset, choosePreset,
    setMinPrice: changeMinPrice, setMaxPrice: changeMaxPrice, fillMax, signAndSend,
    now, refreshQuote, canRefreshQuote, retryConfirmation: open.retry,
    dismissPendingSwap: () => { if (!busy) setSwapReceipt(null); },
    createAnother: () => { if (!busy && open.canSubmit()) { open.dismissTerminal(); clearQuote(); } },
  };
}
