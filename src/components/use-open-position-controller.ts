"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { formatAmount, parseTokenAmount } from "@sofinance/engine/amount";
import { NATIVE_SOL_MINT, USDC_MINT } from "@sofinance/engine/ids";
import { quoteIsFresh } from "@sofinance/engine/quote-math";
import { OPEN_RANGE_UI_PRESETS, type OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { addMintSignature, assertWalletReturnedTransaction, missingRequiredSignatures } from "@/lib/open-signatures";
import { createJupiterRelayStore, jupiterRelayEnabled, jupiterRelayFailureMessage, postWithJupiterRelay } from "@/lib/jupiter/browser-relay";
import { notSentRetryMessage } from "@/lib/public-error";
import type { OpenPositionQuote, OpenPositionSummary } from "@sofinance/engine/open-types";
import { openAttemptFromSummary, type OpenAttempt } from "@/lib/open-attempt";
import { NO_BEAM_STATUS, openBeamStatus, type OpenBeamStatus } from "@/lib/open-beam-status";
import type { WalletAsset, WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { useWalletConnection } from "./wallet-connection";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";
import { useOpenAttempt } from "./use-open-attempt";
import { getStoredAttribution } from "@/lib/analytics/attribution";
import { captureGrowthEvent, captureGrowthEventOnce } from "@/lib/analytics/client";
import { classifyOpenError } from "@/lib/analytics/errors";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";

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
type Prepared = {
  unsignedTransaction: string;
  permit: string;
  summary: OpenPositionSummary;
};

export type OpenSubmitStage = "preparing" | "wallet" | "broadcasting" | "pending" | "confirmed" | "failed" | "expired" | "manual-review" | null;

function pickInput(assets: WalletAsset[], mintA: string, mintB: string): WalletAsset | null {
  const eligible = assets.filter((item) => item.eligible);
  const preferred = [USDC_MINT, NATIVE_SOL_MINT, mintA, mintB];
  for (const mint of preferred) {
    const found = eligible.find((item) => item.mint === mint);
    if (found) return found;
  }
  return eligible.find((item) => item.mint === mintA || item.mint === mintB || item.mint === NATIVE_SOL_MINT || item.mint === USDC_MINT) ?? null;
}

/** Background quote polling pauses this long after a failed refresh. */
export const QUOTE_ERROR_POLL_PAUSE_MS = 30_000;
/** Server-keyed polling interval (relay disabled). */
export const QUOTE_POLL_MS = 3_000;
/**
 * Browser-quoted polling interval. Jupiter's keyless quota is ~5 requests / 10 s
 * per IP and an open preview costs 2-4 quotes, so poll well under that.
 */
export const RELAY_QUOTE_POLL_MS = 15_000;
/** Hard cap so quote/prepare cannot spin past a Jupiter 429 wait with no UI error. */
export const OPEN_QUOTE_TIMEOUT_MS = 45_000;
export const OPEN_PREPARE_TIMEOUT_MS = 45_000;

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
  const [quote, setQuote] = useState<OpenPositionQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState("");
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [operationStage, setSubmitStage] = useState<OpenSubmitStage>(null);
  const [error, setError] = useState("");
  // Beam metadata from prepare/broadcast, keyed to the attempt signature; shown only once that attempt is verified.
  const [beamResult, setBeamResult] = useState<{ signature: string; status: OpenBeamStatus } | null>(null);
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const quoteRequestRef = useRef(0);
  const jupiterStoreRef = useRef(createJupiterRelayStore());
  const submittingRef = useRef(false);
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

  useEffect(() => {
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
            rangePreset, minPrice, maxPrice,
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
  }, [amount, busy, formError, inputKind, inputMint, maxPrice, minPrice, pair, parsedAmount, quoteRevision, rangePreset, selectedAsset, submitStage, wallet]);

  const clearQuote = () => {
    quoteRequestRef.current += 1;
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
    setQuoteRevision((revision) => revision + 1);
  };

  const fillMax = () => {
    if (!selectedAsset) return;
    changeAmount(formatAmount(selectedAsset.balance, selectedAsset.decimals, selectedAsset.decimals));
  };

  const signAndSend = useCallback(async () => {
    if (!pair || !wallet || !inputMint || !quote || !fresh || Date.now() >= quote.expiresAt || busy || !open.loaded || submittingRef.current) return;
    submittingRef.current = true;
    const requestedIdentity = identity;
    const current = () => activeRef.current && walletRef.current === wallet && identityRef.current === requestedIdentity;
    let persisted: OpenAttempt | null = null;
    setQuoteLoading(false);
    setSubmitStage("preparing");
    setError("");
    captureGrowthEvent(GROWTH_EVENTS.openStarted, openEventProperties(pair));
    const mint = Keypair.generate();
    try {
      // Same per-modal store as the preview: prepare replays the preview's fresh
      // Jupiter quotes and only fetches swap-instructions.
      const response = await postWithJupiterRelay("/api/open-prepare", {
        wallet, poolId: pair.poolAddress, inputMint, inputKind, amount,
        rangePreset, minPrice, maxPrice, nftMint: mint.publicKey.toBase58(),
      }, { store: jupiterStoreRef.current, signal: AbortSignal.timeout(OPEN_PREPARE_TIMEOUT_MS) });
      const data = await response.json() as Prepared | ApiError;
      if (!response.ok) throw new Error((data as ApiError).error);
      const prepared = data as Prepared;
      if (!current() || !prepared.unsignedTransaction || !prepared.permit || !prepared.summary ||
        prepared.summary.wallet !== wallet || prepared.summary.poolId !== pair.poolAddress ||
        prepared.summary.nftMint !== mint.publicKey.toBase58() ||
        prepared.summary.quote.requested !== parsedAmount?.toString() ||
        prepared.summary.quote.inputMint !== inputMint || prepared.summary.quote.inputKind !== inputKind ||
        Date.now() >= prepared.summary.expiresAt) {
        throw new Error("Prepared open-position transaction expired or incomplete");
      }
      const bytes = Uint8Array.from(atob(prepared.unsignedTransaction), (character) => character.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      const preparedSnapshot = VersionedTransaction.deserialize(unsigned.serialize());
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet ||
        unsigned.message.staticAccountKeys[1]?.toBase58() !== prepared.summary.nftMint ||
        unsigned.message.recentBlockhash !== prepared.summary.blockhash) {
        throw new Error("Transaction payer mismatch");
      }
      setQuote(prepared.summary.quote);
      setNow(Date.now());
      setSubmitStage("wallet");
      const signedByWallet = await signTransaction(unsigned);
      assertWalletReturnedTransaction(preparedSnapshot, signedByWallet, wallet);
      const signed = addMintSignature(signedByWallet, mint);
      mint.secretKey.fill(0);
      if (missingRequiredSignatures(signed).length) {
        throw new Error("Open-position transaction is missing required signatures");
      }
      const signatureBytes = signed.signatures[0]!;
      const txSignature = bs58.encode(signatureBytes);
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      if (!current() || Date.now() >= prepared.summary.expiresAt) throw new Error("Wallet, input or quote changed during signing; transaction not sent");
      const attempt = openAttemptFromSummary(txSignature, prepared.summary);
      open.track(attempt);
      persisted = attempt;
      setSubmitStage("broadcasting");
      const sent = await fetch("/api/open-broadcast", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          signedTransaction,
          unsignedTransaction: prepared.unsignedTransaction,
          permit: prepared.permit,
          wallet,
          summary: prepared.summary,
          sourceRef: getStoredAttribution()?.ref,
        }),
        cache: "no-store", signal: AbortSignal.timeout(15_000),
      });
      const broadcast = await sent.json() as { signature?: string; positionMint?: string; beamLabel?: string | null; error?: string; sent?: boolean };
      if (!sent.ok) {
        const reason = broadcast.error || "Open-position submission failed";
        if (broadcast.sent === false) {
          open.markUnsent(attempt);
          persisted = null;
        }
        throw new Error(broadcast.sent === false ? notSentRetryMessage(reason) : reason);
      }
      if (broadcast.signature !== txSignature) throw new Error("RPC returned transaction signature mismatch");
      // Signature acceptance is pending; useOpenAttempt checks finality and position facts.
      setBeamResult({ signature: txSignature, status: openBeamStatus(prepared.summary.beam, broadcast.beamLabel) });
    } catch (caught) {
      if (!persisted) {
        captureGrowthEvent(GROWTH_EVENTS.openFailed, {
          ...openEventProperties(pair),
          error_class: classifyOpenError(caught),
        });
      }
      if (walletRef.current === wallet) setError(persisted
        ? "Submission result is unconfirmed. Tracking the original signature; do not open again until it is verified."
        : jupiterRelayFailureMessage(caught, "Preparing the transaction timed out. Please retry."));
    } finally {
      mint.secretKey.fill(0);
      submittingRef.current = false;
      setSubmitStage(null);
    }
  }, [amount, busy, fresh, identity, inputKind, inputMint, maxPrice, minPrice, open, pair, parsedAmount, quote, rangePreset, signTransaction, wallet]);

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
    createAnother: () => { if (!busy) { open.dismissTerminal(); clearQuote(); setQuoteRevision(revision => revision + 1); } },
  };
}
