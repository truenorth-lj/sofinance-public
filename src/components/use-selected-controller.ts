"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { formatAmount, parseTokenAmount, toleranceFromPercent } from "@sofinance/engine/amount";
import { persistSelectedAttempt, type SelectedAttempt } from "@/lib/selected-attempt";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";
import type { WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { INPUT_ASSET_NOT_HELD_CODE, INPUT_ASSET_NOT_HELD_MESSAGE } from "@/lib/selected-input-asset-not-held";
import { useWalletConnection } from "./wallet-connection";
import { createJupiterRelayStore, postWithJupiterRelay } from "@/lib/jupiter/browser-relay";
import { useSelectedAttempt, useSelectedAttemptEffects } from "./transactions/selected/use-selected-attempt";
import { useSelectedPreview, useSelectedPreviewEffect } from "./transactions/selected/use-selected-preview";
import { RELAY_DEADLINE_MS, selectionKey, type Preflight } from "./transactions/selected/selected-preview-model";

export { RELAY_DEADLINE_MS } from "./transactions/selected/selected-preview-model";

type Prepared = Preflight & { unsignedTransaction: string; blockhash: string;
  lastValidBlockHeight: number; startingLiquidity: string;
  startingBalances: SelectedPositionState["balances"]; expiresAt: number; permit: string };
type ApiError = { error: string; code?: string; inputMint?: string; outputMint?: string };

export function useSelectedController() {
  const { address: wallet, connected, connect, disconnect, isMobile, walletsCount,
    connectionError, signTransaction } = useWalletConnection();
  const [discovery, setDiscovery] = useState<WalletDiscovery | null>(null);
  const [selection, setSelection] = useState<PositionSelection | null>(null);
  const [selectedState, setSelectedState] = useState<SelectedPositionState | null>(null);
  const [amount, setAmount] = useState("");
  const [tolerancePercent, setTolerancePercent] = useState("1.0");
  const previewController = useSelectedPreview();
  const { preview, quoteError, quoteErrorCode, quoteErrorOutputMint, quoteLoading,
    invalidate: invalidatePreview, invalidateForInput: invalidateInputPreview,
    clear: clearPreview, clearErrors: clearQuoteErrors,
    adopt: adoptPreview, retryCalculation, showQuoteRecalculate } = previewController;
  const [error, setError] = useState("");
  const [stateError, setStateError] = useState("");
  const [submitStage, setSubmitStage] = useState<"preparing" | "wallet" | "broadcasting" | null>(null);
  const busy = submitStage !== null;
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
  const submittingRef = useRef(false);
  const lifetimeRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // A fresh token on every setup prevents effect replay from reviving old work.
    lifetimeRef.current = {};
    return () => { lifetimeRef.current = null; };
  }, []);
  const getLifetime = useCallback(() => lifetimeRef.current, []);
  const isWalletCurrent = useCallback((address: string) => walletRef.current === address, []);
  const isSubmitting = useCallback(() => submittingRef.current, []);
  const attemptController = useSelectedAttempt({ wallet, busy, getLifetime, isWalletCurrent, isSubmitting });
  const { attempt, attemptStatus, history, verificationError, obsoletePending, historyWarning,
    beginSubmission, restoreSignature, publishPersisted, reconcileAttempt, retryReconcile, retryObsoleteReconcile } = attemptController;
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
      setAmount(""); setStateError(""); setError(""); clearQuoteErrors();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet, invalidatePreview, clearPreview, clearQuoteErrors]);

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

  useSelectedAttemptEffects({ wallet, busy }, attemptController);

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
    if (submitStage === "broadcasting") return "Sending and checking confirmation…";
    if (calculating) return "Estimating liquidity…";
    if (quote && fresh) return "Preview ready. Final checks run when you add liquidity.";
    if (visibleState.rangeSide === "above") return "Above upper bound: will add single-sided position; no trading fees earned outside range";
    if (visibleState.rangeSide === "below") return "Below lower bound: will add single-sided position; no trading fees earned outside range";
    return "Getting latest quote";
  })();

  useSelectedPreviewEffect({ wallet, selection, amount, rawAmount, floorBps, toleranceBps, ready, busy,
    getRelayStore: getPreviewRelayStore, isCurrent: isPreviewCurrent, setNow }, previewController);

  async function signAndSend() {
    const lifetime = lifetimeRef.current;
    if (!lifetime) return;
    const ownsLifetime = () => lifetimeRef.current === lifetime;
    if (!ready || busy || submittingRef.current || quoteLoading || !quote || !fresh ||
      !wallet || !selection || !visibleState || toleranceBps === null) return;
    submittingRef.current = true;
    beginSubmission();
    const key = selectionKey(selection);
    const inputRevision = inputRevisionRef.current;
    setSubmitStage("preparing"); setError("");
    const aborter = new AbortController();
    const deadline = window.setTimeout(() => aborter.abort(new Error("Preparation took too long. Please retry.")), RELAY_DEADLINE_MS);
    try {
      const response = await postWithJupiterRelay("/api/selected-prepare", { wallet, ...selection, amount, floorBps, toleranceBps },
        { store: jupiterStoreRef.current, signal: aborter.signal });
      const data = await response.json() as Prepared | ApiError;
      window.clearTimeout(deadline);
      if (!ownsLifetime()) return;
      if (aborter.signal.aborted) throw aborter.signal.reason;
      if (!response.ok) throw new Error((data as ApiError).error);
      const prepared = data as Prepared;
      if (walletRef.current !== wallet || selectionRef.current !== key || inputRevisionRef.current !== inputRevision ||
        !prepared.simulated || !prepared.permit || !prepared.startingBalances ||
        prepared.quote.wallet !== wallet ||
        selectionKey(prepared.quote) !== key || prepared.quote.requested !== rawAmount.toString() ||
        prepared.quote.floorBps !== floorBps || prepared.quote.toleranceBps !== toleranceBps || Date.now() >= prepared.expiresAt) {
        throw new Error("Requote or transaction authorization and current selection mismatch");
      }
      const bytes = Uint8Array.from(atob(prepared.unsignedTransaction), (character) => character.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      if (unsigned.message.recentBlockhash !== prepared.blockhash ||
        unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("Transaction payer or blockhash mismatch");
      adoptPreview(prepared); setNow(Date.now());
      setSubmitStage("wallet");
      const originalMessage = unsigned.message.serialize();
      const signed = await signTransaction(unsigned);
      if (!ownsLifetime()) return;
      const signedMessage = signed.message.serialize();
      if (signedMessage.length !== originalMessage.length || signedMessage.some((byte, index) => byte !== originalMessage[index])) {
        throw new Error("Wallet modified transaction content, stopped submission");
      }
      const signatureBytes = signed.signatures[0];
      if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) throw new Error("Wallet did not return valid signature");
      if (walletRef.current !== wallet || selectionRef.current !== key || inputRevisionRef.current !== inputRevision ||
        Date.now() >= prepared.expiresAt) throw new Error("Wallet, selection, or quote changed during signing; transaction not sent");
      const signature = bs58.encode(signatureBytes);
      const current: SelectedAttempt = { version: 2, wallet, selection, poolId: prepared.quote.poolId,
        positionAccount: prepared.quote.positionAccount, signature, createdAt: Date.now(),
        requested: prepared.quote.requested, floorBps: prepared.quote.floorBps,
        startingBalances: prepared.startingBalances, startingLiquidity: prepared.startingLiquidity,
        expectedLiquidity: prepared.quote.liquidity, blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight };
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      persistSelectedAttempt(window.localStorage, current);
      publishPersisted(current);
      clearPreview(); setSubmitStage("broadcasting");
      const sent = await fetch("/api/selected-broadcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, selection, signedTransaction, permit: prepared.permit,
          requested: prepared.quote.requested, floorBps: prepared.quote.floorBps,
          expiresAt: prepared.expiresAt, lastValidBlockHeight: prepared.lastValidBlockHeight,
          startingLiquidity: prepared.startingLiquidity, expectedLiquidity: prepared.quote.liquidity,
          rangeSide: prepared.quote.rangeSide, startingBalances: prepared.startingBalances }), cache: "no-store",
        signal: AbortSignal.timeout(15_000) });
      const broadcast = await sent.json() as { signature?: string; error?: string };
      if (!ownsLifetime()) return;
      if (!sent.ok) throw new Error(broadcast.error || "Dedicated RPC rejected transaction; verify on-chain status");
      if (broadcast.signature !== signature) throw new Error("Dedicated RPC returned inconsistent transaction signature, check on-chain status");
      void reconcileAttempt(current);
      void refreshState();
    } catch (caught) {
      if (ownsLifetime() && walletRef.current === wallet) setError(caught instanceof Error ? caught.message : "Transaction not confirmed; check on-chain status before proceeding");
    }
    finally {
      window.clearTimeout(deadline); submittingRef.current = false;
      if (ownsLifetime() && walletRef.current === wallet) restoreSignature(attempt?.signature ?? null);
      // Keep the synchronous lock until this run settles, including effect replay.
      // Clear retained state even while effects are disconnected; no newer run
      // can own the stage yet. React ignores this after a true unmount.
      setSubmitStage(null);
    }
  }

  const actionLabel = submitStage === "preparing" ? "Preparing latest transaction…" : submitStage === "wallet" ?
    "Confirming in wallet…" : submitStage === "broadcasting" ? "Sending and verifying…" : "Add liquidity";
  const actionDisabled = busy || !ready || quoteLoading || !quote || !fresh;
  const walletBlocked = busy;
  const primaryAction = () => { void signAndSend(); };
  const changeAmount = (value: string) => {
    inputRevisionRef.current++; invalidateInputPreview(); setAmount(value); clearPreview();
    setError(""); clearQuoteErrors();
  };
  const changeTolerance = (value: string) => {
    inputRevisionRef.current++; invalidateInputPreview(); setTolerancePercent(value); clearPreview();
    setError(""); clearQuoteErrors();
  };
  const fillMax = () => changeAmount(visibleState ? formatAmount(visibleState.inputBalance, visibleState.inputDecimals, visibleState.inputDecimals) : "");
  const choosePosition = (positionMint: string) => setSelection((current) => current ? { ...current, positionMint } : null);
  const chooseAsset = (kind: "native" | "token", mint: string) => setSelection((current) => current ? { ...current, inputKind: kind, inputMint: mint } : null);
  return { wallet, connected, connect, disconnect, isMobile, walletsCount, connectionError,
    discovery, selection, state: visibleState, amount, tolerancePercent, result: displayedResult, attempt,
    attemptStatus, obsoletePending, history: history.filter(item => item.wallet === wallet), historyWarning, verificationError,
    error: error || quoteError, quoteError, quoteErrorCode, quoteErrorOutputMint, showQuoteRecalculate,
    busy, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled, walletBlocked, primaryAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation, retryReconcile, retryObsoleteReconcile,
    loadingDiscovery, loadingState, stateError };
}
