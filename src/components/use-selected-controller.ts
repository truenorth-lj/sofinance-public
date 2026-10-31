"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatAmount, parseTokenAmount, toleranceFromPercent } from "@sofinance/engine/amount";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";
import type { WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { INPUT_ASSET_NOT_HELD_CODE, INPUT_ASSET_NOT_HELD_MESSAGE } from "@/lib/selected-input-asset-not-held";
import { useWalletConnection } from "./wallet-connection";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { useSelectedPreview, useSelectedPreviewEffect } from "./transactions/selected/use-selected-preview";
import { selectionKey } from "./transactions/selected/selected-preview-model";
import { BALANCES_REFRESH_EVENT } from "@/lib/tx-pipeline";
import { useTxPipeline } from "./transactions/use-tx-pipeline";
import { addLiquidityAdapter } from "./transactions/adapters/add";

export { RELAY_DEADLINE_MS } from "./transactions/selected/selected-preview-model";

type ApiError = { error: string; code?: string; inputMint?: string; outputMint?: string };

export function useSelectedController() {
  const { address: wallet, connected, connect, disconnect, isMobile, walletsCount,
    connectionError, signTransaction, signAndSendTransaction } = useWalletConnection();
  const [discovery, setDiscovery] = useState<WalletDiscovery | null>(null);
  const [selection, setSelection] = useState<PositionSelection | null>(null);
  const [selectedState, setSelectedState] = useState<SelectedPositionState | null>(null);
  const [amount, setAmount] = useState("");
  const [tolerancePercent, setTolerancePercent] = useState("1.0");
  const previewController = useSelectedPreview();
  const { preview, quoteError, quoteErrorCode, quoteErrorOutputMint, quoteLoading,
    invalidate: invalidatePreview, invalidateForInput: invalidateInputPreview,
    clear: clearPreview, clearErrors: clearQuoteErrors,
    retryCalculation, showQuoteRecalculate } = previewController;
  const txWallet = useMemo(() => wallet ? { address: wallet, signTransaction, signAndSendTransaction } : null,
    [wallet, signTransaction, signAndSendTransaction]);
  const tx = useTxPipeline(addLiquidityAdapter, txWallet);
  const { busy, reset: clearError } = tx;
  const submitStage = tx.status === "preparing" || tx.status === "wallet" ? tx.status : null;
  const error = tx.status === "failed" ? tx.error ?? "" : "";
  const [stateError, setStateError] = useState("");
  const [loadingDiscovery, setLoadingDiscovery] = useState(false);
  const [loadingState, setLoadingState] = useState(false);
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const selectionRef = useRef(selectionKey(selection));
  const discoveryRequestRef = useRef(0);
  const stateRequestRef = useRef(0);
  // Browser-fetched Jupiter responses, shared by preview and prepare of this panel.
  const jupiterStoreRef = useRef(createJupiterRelayStore());
  const getPreviewRelayStore = useCallback(() => jupiterStoreRef.current, []);
  const inputRevisionRef = useRef(0);
  const previewResult = preview.kind === "idle" ? null : preview.result;
  const result = previewResult && previewResult.quote.wallet === wallet &&
    selectionKey(previewResult.quote) === selectionKey(selection) ? previewResult : null;
  const isPreviewCurrent = useCallback((address: string, key: string) =>
    walletRef.current === address && selectionRef.current === key, []);

  useEffect(() => {
    walletRef.current = wallet;
    discoveryRequestRef.current++;
    stateRequestRef.current++;
    invalidatePreview();
    const timer = window.setTimeout(() => {
      setDiscovery(null); setSelection(null); setSelectedState(null); clearPreview();
      setAmount(""); setStateError(""); clearError(); clearQuoteErrors();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet, invalidatePreview, clearPreview, clearQuoteErrors, clearError]);

  useEffect(() => {
    selectionRef.current = selectionKey(selection);
    stateRequestRef.current++;
    invalidatePreview();
    const timer = window.setTimeout(() => { setSelectedState(null); clearPreview(); setAmount(""); }, 0);
    return () => window.clearTimeout(timer);
  }, [selection, invalidatePreview, clearPreview]);

  const refreshDiscovery = useCallback(async () => {
    if (!wallet) { setDiscovery(null); return; }
    const requestId = ++discoveryRequestRef.current;
    setLoadingDiscovery(true); setStateError("");
    try {
      const response = await fetch(`/api/wallet?wallet=${encodeURIComponent(wallet)}`, { cache: "no-store" });
      const data = await response.json() as WalletDiscovery | ApiError;
      if (!response.ok) throw new Error((data as ApiError).error);
      if (walletRef.current !== wallet || requestId !== discoveryRequestRef.current) return;
      const found = data as WalletDiscovery;
      setDiscovery(found);
      setSelection((current) => {
        if (current && found.positions.some((item) => item.positionMint === current.positionMint) &&
          found.assets.some((item) => item.kind === current.inputKind && item.mint === current.inputMint && item.eligible)) return current;
        const position = found.positions[0];
        const asset = found.assets.find((item) => item.mint === USDC_MINT && item.eligible) ||
          found.assets.find((item) => item.eligible);
        return position && asset ? { positionMint: position.positionMint,
          inputMint: asset.mint, inputKind: asset.kind } : null;
      });
    } catch (caught) {
      if (walletRef.current === wallet && requestId === discoveryRequestRef.current) {
        setDiscovery(null); setStateError(caught instanceof Error ? caught.message : "Wallet scan failed");
      }
    } finally {
      if (walletRef.current === wallet && requestId === discoveryRequestRef.current) setLoadingDiscovery(false);
    }
  }, [wallet]);

  const refreshState = useCallback(async () => {
    if (!wallet || !selection) { setSelectedState(null); return; }
    const requestId = ++stateRequestRef.current;
    const key = selectionKey(selection);
    setLoadingState(true); setStateError("");
    try {
      const params = new URLSearchParams({ wallet, ...selection });
      const response = await fetch(`/api/selected-state?${params}`, { cache: "no-store" });
      const data = await response.json() as SelectedPositionState | ApiError;
      if (!response.ok) {
        const failed = data as ApiError;
        throw new Error(failed.code === INPUT_ASSET_NOT_HELD_CODE ? INPUT_ASSET_NOT_HELD_MESSAGE : failed.error);
      }
      if (walletRef.current === wallet && selectionRef.current === key && requestId === stateRequestRef.current) {
        setSelectedState(data as SelectedPositionState);
      }
    } catch (caught) {
      if (walletRef.current === wallet && selectionRef.current === key && requestId === stateRequestRef.current) {
        setSelectedState(null); setStateError(caught instanceof Error ? caught.message : "Selected position reading failed");
      }
    } finally {
      if (walletRef.current === wallet && selectionRef.current === key && requestId === stateRequestRef.current) setLoadingState(false);
    }
  }, [wallet, selection]);

  useEffect(() => { const timer = window.setTimeout(() => { void refreshDiscovery(); }, 0); return () => window.clearTimeout(timer); }, [refreshDiscovery]);
  useEffect(() => { const timer = window.setTimeout(() => { void refreshState(); }, 0); return () => window.clearTimeout(timer); }, [refreshState]);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);

  // A transaction notice finished (possibly from a closed panel): refresh balances and position.
  useEffect(() => {
    const refresh = () => { void refreshState(); };
    window.addEventListener(BALANCES_REFRESH_EVENT, refresh);
    return () => window.removeEventListener(BALANCES_REFRESH_EVENT, refresh);
  }, [refreshState]);

  const visibleState = selectedState?.wallet === wallet && selectionKey(selectedState) === selectionKey(selection)
    ? selectedState : null;
  let rawAmount = 0n;
  try { if (amount && visibleState) rawAmount = parseTokenAmount(amount, visibleState.inputDecimals); }
  catch { /* The status text gives amount guidance. */ }
  const floorBps = DEFAULT_RESALE_FLOOR_BPS;
  let toleranceBps: number | null = null;
  try { toleranceBps = toleranceFromPercent(tolerancePercent); }
  catch { /* The status text gives setting guidance. */ }
  const affordable = visibleState && rawAmount <= BigInt(visibleState.inputBalance);
  const ready = connected && !!visibleState && visibleState.ownsNft &&
    !visibleState.paused && !visibleState.frozen && !visibleState.transferFee &&
    !visibleState.unsupportedExtensions.length && visibleState.sufficientSol && rawAmount > 0n &&
    affordable && toleranceBps !== null;
  const quote = result && result.quote.wallet === wallet && selectionKey(result.quote) === selectionKey(selection) &&
    BigInt(result.quote.requested) === rawAmount && result.quote.floorBps === floorBps &&
    result.quote.toleranceBps === toleranceBps ? result.quote : null;
  const displayedResult = quote ? result : null;
  const fresh = quote ? now < (result?.expiresAt ?? quote.expiresAt) : false;
  const calculating = Boolean(ready && (quoteLoading || !quote || !fresh) && !quoteError && !busy);
  const status = (() => {
    if (!connected) return "Please connect wallet first";
    if (loadingDiscovery) return "Scanning wallet assets and Raydium CLMM positions";
    if (stateError) return stateError;
    if (!discovery?.positions.length) return "Wallet has no identifiable Raydium CLMM position NFT";
    if (!discovery.assets.some((item) => item.eligible)) return "Wallet has no available for input assets";
    if (!selection) return "Please select position and input asset";
    if (loadingState || !visibleState) return "Verifying selected position";
    if (!visibleState.ownsNft) return "Selected NFT not available in this wallet ATA";
    if (visibleState.paused || visibleState.frozen || visibleState.transferFee ||
      visibleState.unsupportedExtensions.length) return "Selected pool asset settings not yet supported";
    if (!visibleState.sufficientSol) return "SOL insufficient, need to reserve at least 0.01 SOL";
    if (toleranceBps === null) return "Price tolerance must be 0–5%, adjust by 0.1% each time";
    if (rawAmount <= 0n) return "Please enter input amount matching asset precision";
    if (!affordable) return "Selected asset balance insufficient";
    if (quoteError) return quoteError;
    if (submitStage === "preparing") return "Preparing and checking your transaction…";
    if (submitStage === "wallet") return "Confirm in your wallet";
    if (calculating) return "Estimating liquidity…";
    if (quote && fresh) return "Preview ready. Final checks run when you add liquidity.";
    if (visibleState.rangeSide === "above") return "Above upper bound: will add single-sided position; no trading fees earned outside range";
    if (visibleState.rangeSide === "below") return "Below lower bound: will add single-sided position; no trading fees earned outside range";
    return "Getting latest quote";
  })();

  useSelectedPreviewEffect({ wallet, selection, amount, rawAmount, floorBps, toleranceBps, ready, busy,
    getRelayStore: getPreviewRelayStore, isCurrent: isPreviewCurrent, setNow }, previewController);

  const signAndSend = async () => {
    if (!ready || busy || quoteLoading || !quote || !fresh || !wallet || !selection || toleranceBps === null) return;
    const sent = await tx.run({ selection, amount, rawAmount, floorBps, toleranceBps, relayStore: getPreviewRelayStore() });
    if (sent && walletRef.current === wallet) { clearPreview(); void refreshState(); }
  };
  // The add panel's own view of the shared pipeline: the signature it sent and how it settled.
  const attempt = tx.signature && wallet && selection ? { signature: tx.signature, wallet, positionMint: selection.positionMint } : null;
  const attemptStatus = tx.status === "confirming" ? "pending" as const : tx.status === "success" ? "success" as const
    : tx.signature && tx.status === "failed" ? (tx.kind === "expired" ? "expired" as const : "failed" as const) : null;

  const actionLabel = submitStage === "preparing" ? "Preparing latest transaction…" : submitStage === "wallet" ?
    "Confirm in your wallet…" : "Add liquidity";
  const actionDisabled = busy || !ready || quoteLoading || !quote || !fresh;
  const walletBlocked = busy;
  const primaryAction = () => { void signAndSend(); };
  /** Status dialog "Try again": re-prepare and re-sign the same add (only once the last one expired or failed). */
  const retryAdd = tx.status === "failed" && tx.retryable && !busy ? tx.retry : undefined;
  const changeAmount = (value: string) => {
    inputRevisionRef.current++; invalidateInputPreview(); setAmount(value); clearPreview();
    clearError(); clearQuoteErrors();
  };
  const changeTolerance = (value: string) => {
    inputRevisionRef.current++; invalidateInputPreview(); setTolerancePercent(value); clearPreview();
    clearError(); clearQuoteErrors();
  };
  const fillMax = () => changeAmount(visibleState ? formatAmount(visibleState.inputBalance, visibleState.inputDecimals, visibleState.inputDecimals) : "");
  const choosePosition = (positionMint: string) => setSelection((current) => current ? { ...current, positionMint } : null);
  const chooseAsset = (kind: "native" | "token", mint: string) => setSelection((current) => current ? { ...current, inputKind: kind, inputMint: mint } : null);
  return { wallet, connected, connect, disconnect, isMobile, walletsCount, connectionError,
    discovery, selection, state: visibleState, amount, tolerancePercent, result: displayedResult, attempt, attemptStatus,
    error: error || quoteError, reprepare: tx.status === "failed" && !!tx.retryable, quoteError, quoteErrorCode, quoteErrorOutputMint, showQuoteRecalculate,
    busy, retryAdd, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled, walletBlocked, primaryAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation,
    loadingDiscovery, loadingState, stateError };
}
