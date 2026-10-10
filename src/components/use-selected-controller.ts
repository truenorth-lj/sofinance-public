"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { formatAmount, parseTokenAmount, toleranceFromPercent } from "@/lib/amount";
import { mayStartAnotherAttempt, type AtomicStatus } from "@/lib/attempt-status";
import { loadSelectedAttempt, selectedAttemptKey, type SelectedAttempt } from "@/lib/selected-attempt";
import { readObsoleteAttempts } from "@/lib/obsolete-attempt";
import type { SelectedQuote } from "@/lib/selected-quote";
import type { PositionSelection, SelectedPositionState } from "@/lib/selected-state";
import type { WalletDiscovery } from "@/lib/wallet-discovery";
import { DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@/lib/ids";
import { useWalletConnection } from "./wallet-connection";

type Preflight = { quote: SelectedQuote; simulated: boolean; sizeBytes?: number; unitsConsumed?: number;
  feeLamports?: number; startingLiquidity?: string; simulatedEndingLiquidity?: string;
  simulatedAt?: number; expiresAt?: number; startingBalances?: SelectedPositionState["balances"];
  simulatedInputSpent?: string | null; simulatedSolDebitLamports?: string;
  simulatedDustA?: string; simulatedDustB?: string; blockhash?: string;
  lastValidBlockHeight?: number };
type Prepared = Preflight & { unsignedTransaction: string; blockhash: string;
  lastValidBlockHeight: number; startingLiquidity: string;
  startingBalances: SelectedPositionState["balances"]; expiresAt: number; permit: string };
type StatusResponse = { status: AtomicStatus; state: SelectedPositionState | null; signature: string; transactionError?: unknown };
type ApiError = { error: string };
type Preview = { kind: "idle" } | { kind: "quoted"; result: Preflight };

function selectionKey(selection: PositionSelection | null) {
  return selection ? `${selection.positionMint}:${selection.inputKind}:${selection.inputMint}` : "";
}

export function useSelectedController() {
  const { address: wallet, connected, connect, disconnect, isMobile, walletsCount,
    connectionError, signTransaction } = useWalletConnection();
  const [discovery, setDiscovery] = useState<WalletDiscovery | null>(null);
  const [selection, setSelection] = useState<PositionSelection | null>(null);
  const [selectedState, setSelectedState] = useState<SelectedPositionState | null>(null);
  const [amount, setAmount] = useState("");
  const [tolerancePercent, setTolerancePercent] = useState("1.0");
  const [preview, setPreview] = useState<Preview>({ kind: "idle" });
  const [attempt, setAttempt] = useState<SelectedAttempt | null>(null);
  const [attemptStatus, setAttemptStatus] = useState<AtomicStatus | null>(null);
  const [obsoletePending, setObsoletePending] = useState(false);
  const [attemptLoadedWallet, setAttemptLoadedWallet] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [quoteError, setQuoteError] = useState("");
  const [stateError, setStateError] = useState("");
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [submitStage, setSubmitStage] = useState<"preparing" | "wallet" | "broadcasting" | null>(null);
  const busy = submitStage !== null;
  const [loadingDiscovery, setLoadingDiscovery] = useState(false);
  const [loadingState, setLoadingState] = useState(false);
  const [now, setNow] = useState(0);
  const walletRef = useRef(wallet);
  const selectionRef = useRef(selectionKey(selection));
  const discoveryRequestRef = useRef(0);
  const stateRequestRef = useRef(0);
  const quoteRequestRef = useRef(0);
  const inputRevisionRef = useRef(0);
  const submittingRef = useRef(false);
  const reconcileRequestRef = useRef(0);
  const previewResult = preview.kind === "idle" ? null : preview.result;
  const result = previewResult && previewResult.quote.wallet === wallet &&
    selectionKey(previewResult.quote) === selectionKey(selection) ? previewResult : null;

  useEffect(() => {
    walletRef.current = wallet;
    discoveryRequestRef.current++;
    stateRequestRef.current++;
    quoteRequestRef.current++;
    const timer = window.setTimeout(() => {
      setDiscovery(null); setSelection(null); setSelectedState(null); setPreview({ kind: "idle" });
      setAmount(""); setStateError(""); setError("");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet]);

  useEffect(() => {
    selectionRef.current = selectionKey(selection);
    stateRequestRef.current++;
    quoteRequestRef.current++;
    const timer = window.setTimeout(() => { setSelectedState(null); setPreview({ kind: "idle" }); setAmount(""); }, 0);
    return () => window.clearTimeout(timer);
  }, [selection]);

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
      if (!response.ok) throw new Error((data as ApiError).error);
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

  const reconcileObsolete = useCallback(async (address: string) => {
    const { attempts, invalid } = readObsoleteAttempts(window.localStorage, address);
    let pending = invalid;
    for (const old of attempts) {
      const response = await fetch("/api/transaction-finality", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signature: old.signature, lastValidBlockHeight: old.lastValidBlockHeight }), cache: "no-store" });
      if (!response.ok) throw new Error("Previous transaction on-chain state cannot be verified, new liquidity additions paused");
      const data = await response.json() as { status: "finalized" | "failed" | "expired" | "pending" };
      if (data.status === "finalized" || data.status === "failed" || data.status === "expired") {
        window.localStorage.removeItem(old.key);
      } else pending = true;
    }
    return pending;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (!wallet) { setAttempt(null); setAttemptStatus(null); setObsoletePending(false); setAttemptLoadedWallet(null); return; }
      const load = async () => {
        const saved = loadSelectedAttempt(window.localStorage, wallet);
        const pending = await reconcileObsolete(wallet).catch(() => true);
        if (cancelled || walletRef.current !== wallet) return;
        setAttempt(saved.attempt);
        setAttemptStatus(saved.invalid ? "manual-review" : saved.attempt ? "pending" : null);
        setObsoletePending(pending);
        setAttemptLoadedWallet(wallet);
      };
      void load().catch(() => {
        if (cancelled || walletRef.current !== wallet) return;
        setAttempt(null); setAttemptStatus("manual-review"); setObsoletePending(true); setAttemptLoadedWallet(wallet);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [wallet, reconcileObsolete]);

  const reconcileAttempt = useCallback(async (current: SelectedAttempt) => {
    const requestId = ++reconcileRequestRef.current;
    const response = await fetch("/api/selected-status", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: current.wallet, selection: current.selection, poolId: current.poolId,
        positionAccount: current.positionAccount, signature: current.signature,
        startingLiquidity: current.startingLiquidity, expectedLiquidity: current.expectedLiquidity,
        startingBalances: current.startingBalances, lastValidBlockHeight: current.lastValidBlockHeight }), cache: "no-store" });
    const data = await response.json() as StatusResponse | ApiError;
    if (!response.ok) throw new Error((data as ApiError).error);
    if (walletRef.current !== current.wallet || requestId !== reconcileRequestRef.current) return;
    const checked = data as StatusResponse;
    setAttemptStatus(checked.status);
    if (["success", "failed", "expired"].includes(checked.status)) setError("");
    if (checked.state && selectionRef.current === selectionKey(current.selection)) {
      stateRequestRef.current++;
      setSelectedState(checked.state);
    }
  }, []);

  useEffect(() => {
    if (!attempt || attempt.wallet !== wallet || ["success", "expired", "failed", "manual-review"].includes(attemptStatus || "")) return;
    const timer = window.setTimeout(() => { void reconcileAttempt(attempt).catch((caught) => setError(caught instanceof Error ? caught.message : "Transaction status verification failed")); }, 0);
    const poll = window.setInterval(() => { void reconcileAttempt(attempt).catch(() => undefined); }, 4_000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); };
  }, [attempt, attemptStatus, wallet, reconcileAttempt]);

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
  const ready = connected && attemptLoadedWallet === wallet && !!visibleState && visibleState.ownsNft &&
    !visibleState.paused && !visibleState.frozen && !visibleState.transferFee &&
    !visibleState.unsupportedExtensions.length && visibleState.sufficientSol && rawAmount > 0n &&
    affordable && toleranceBps !== null && mayStartAnotherAttempt(attemptStatus) && !obsoletePending;
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
    if (attemptLoadedWallet !== wallet) return "Loading transaction records";
    if (obsoletePending) return "Previous transaction pending on-chain verification, new input paused";
    if (attemptStatus === "pending") return "Signature exists, verifying on-chain status; do not resubmit";
    if (attemptStatus === "manual-review") return "Transaction status requires manual verification, new input paused";
    if (loadingState || !visibleState) return "Verifying selected position";
    if (!visibleState.ownsNft) return "Selected NFT not available in this wallet ATA";
    if (visibleState.paused || visibleState.frozen || visibleState.transferFee ||
      visibleState.unsupportedExtensions.length) return "Selected pool asset settings not yet supported";
    if (!visibleState.sufficientSol) return "SOL insufficient, need to reserve at least 0.01 SOL";
    if (toleranceBps === null) return "Price tolerance must be 0–5%, adjust by 0.1% each time";
    if (rawAmount <= 0n) return "Please enter input amount matching asset precision";
    if (!affordable) return "Selected asset balance insufficient";
    if (quoteError) return quoteError;
    if (calculating) return "Automatically calculating quote and checking transaction";
    if (result?.simulated && fresh) return "Estimation complete, ready to send to wallet for signing";
    if (visibleState.rangeSide === "above") return "Above upper bound: will add single-sided position; no trading fees earned outside range";
    if (visibleState.rangeSide === "below") return "Below lower bound: will add single-sided position; no trading fees earned outside range";
    return "Getting latest quote";
  })();

  useEffect(() => {
    if (!ready || !wallet || !selection || toleranceBps === null || busy) return;
    const requestId = ++quoteRequestRef.current;
    const aborter = new AbortController();
    const key = selectionKey(selection);
    const requested = rawAmount.toString();
    let expiryTimer: number | undefined;
    const scheduleRefresh = (expiresAt: number) => {
      expiryTimer = window.setTimeout(() => setQuoteRevision((current) => current + 1),
        Math.max(1_000, expiresAt - Date.now()));
    };
    const current = () => !aborter.signal.aborted && requestId === quoteRequestRef.current &&
      walletRef.current === wallet && selectionRef.current === key;
    const timer = window.setTimeout(() => {
      const load = async () => {
        setQuoteLoading(true); setPreview({ kind: "idle" }); setQuoteError("");
        try {
          const body = JSON.stringify({ wallet, ...selection, amount, floorBps, toleranceBps });
          const response = await fetch("/api/selected-quote", { method: "POST",
            headers: { "Content-Type": "application/json" }, body, cache: "no-store", signal: aborter.signal });
          const data = await response.json() as SelectedQuote | ApiError;
          if (!current()) return;
          if (!response.ok) throw new Error((data as ApiError).error);
          const currentQuote = data as SelectedQuote;
          if (currentQuote.wallet !== wallet || selectionKey(currentQuote) !== key ||
            currentQuote.requested !== requested || currentQuote.floorBps !== floorBps ||
            currentQuote.toleranceBps !== toleranceBps) {
            throw new Error("Quote and current input mismatch, please re-enter amount");
          }
          setPreview({ kind: "quoted", result: { quote: currentQuote, simulated: false } });
          setNow(Date.now());
          const complete = await fetch("/api/selected-preflight", { method: "POST",
            headers: { "Content-Type": "application/json" }, body, cache: "no-store", signal: aborter.signal });
          const full = await complete.json() as Preflight | ApiError;
          if (!current()) return;
          if (!complete.ok) throw new Error((full as ApiError).error);
          const checked = full as Preflight;
          if (!checked.simulated || checked.quote.wallet !== wallet ||
            selectionKey(checked.quote) !== key || checked.quote.requested !== requested ||
            checked.quote.floorBps !== floorBps || checked.quote.toleranceBps !== toleranceBps) throw new Error("Complete check and current input mismatch");
          setPreview({ kind: "quoted", result: checked }); setNow(Date.now());
          scheduleRefresh(checked.expiresAt ?? checked.quote.expiresAt);
          void refreshState();
        } catch (caught) {
          if (current()) setQuoteError(caught instanceof Error ? caught.message : "Automatic calculation failed");
        } finally {
          if (current()) setQuoteLoading(false);
        }
      };
      void load();
    }, 450);
    return () => {
      aborter.abort(); window.clearTimeout(timer);
      if (expiryTimer !== undefined) window.clearTimeout(expiryTimer);
    };
  }, [amount, busy, floorBps, toleranceBps, quoteRevision, rawAmount, ready, refreshState, selection, wallet]);

  async function signAndSend() {
    if (!ready || busy || submittingRef.current || quoteLoading || !result?.simulated || !fresh ||
      !wallet || !selection || !visibleState || toleranceBps === null) return;
    submittingRef.current = true;
    const key = selectionKey(selection);
    const inputRevision = inputRevisionRef.current;
    setSubmitStage("preparing"); setError("");
    try {
      if (attempt && mayStartAnotherAttempt(attemptStatus)) {
        window.localStorage.removeItem(selectedAttemptKey(wallet)); setAttempt(null); setAttemptStatus(null);
      }
      const response = await fetch("/api/selected-prepare", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, ...selection, amount, floorBps, toleranceBps }), cache: "no-store" });
      const data = await response.json() as Prepared | ApiError;
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
      setSubmitStage("wallet");
      const signed = await signTransaction(unsigned);
      const originalMessage = unsigned.message.serialize();
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
      window.localStorage.setItem(selectedAttemptKey(wallet), JSON.stringify(current));
      setAttempt(current); setAttemptStatus("pending"); setPreview({ kind: "idle" }); setSubmitStage("broadcasting");
      const sent = await fetch("/api/selected-broadcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, selection, signedTransaction, permit: prepared.permit,
          requested: prepared.quote.requested, floorBps: prepared.quote.floorBps,
          expiresAt: prepared.expiresAt, lastValidBlockHeight: prepared.lastValidBlockHeight,
          startingLiquidity: prepared.startingLiquidity, expectedLiquidity: prepared.quote.liquidity,
          rangeSide: prepared.quote.rangeSide, startingBalances: prepared.startingBalances }), cache: "no-store" });
      const broadcast = await sent.json() as { signature?: string; error?: string };
      if (!sent.ok) throw new Error(broadcast.error || "Dedicated RPC rejected transaction; verify on-chain status");
      if (broadcast.signature !== signature) throw new Error("Dedicated RPC returned inconsistent transaction signature, check on-chain status");
      await reconcileAttempt(current);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Transaction not confirmed; check on-chain status before proceeding"); }
    finally { submittingRef.current = false; setSubmitStage(null); }
  }

  const actionLabel = submitStage === "preparing" ? "Preparing latest transaction…" : submitStage === "wallet" ?
    "Confirming in wallet…" : submitStage === "broadcasting" ? "Sending and verifying…" : "Add liquidity";
  const actionDisabled = busy || !ready || quoteLoading || !result?.simulated || !fresh;
  const walletBlocked = Boolean(wallet && (busy || attemptLoadedWallet !== wallet || obsoletePending ||
    !mayStartAnotherAttempt(attemptStatus)));
  const primaryAction = () => { void signAndSend(); };
  const changeAmount = (value: string) => {
    inputRevisionRef.current++; quoteRequestRef.current++; setAmount(value); setPreview({ kind: "idle" });
    setError(""); setQuoteError("");
  };
  const changeTolerance = (value: string) => {
    inputRevisionRef.current++; quoteRequestRef.current++; setTolerancePercent(value); setPreview({ kind: "idle" });
    setError(""); setQuoteError("");
  };
  const retryCalculation = () => { setQuoteError(""); setPreview({ kind: "idle" }); setQuoteRevision((current) => current + 1); };
  const fillMax = () => changeAmount(visibleState ? formatAmount(visibleState.inputBalance, visibleState.inputDecimals, visibleState.inputDecimals) : "");
  const choosePosition = (positionMint: string) => setSelection((current) => current ? { ...current, positionMint } : null);
  const chooseAsset = (kind: "native" | "token", mint: string) => setSelection((current) => current ? { ...current, inputKind: kind, inputMint: mint } : null);
  const retryReconcile = () => { if (attempt) void reconcileAttempt(attempt).catch((caught) => setError(caught instanceof Error ? caught.message : "Re-verification failed")); };
  const retryObsoleteReconcile = () => {
    if (!wallet) return;
    void reconcileObsolete(wallet).then((pending) => { if (walletRef.current === wallet) setObsoletePending(pending); })
      .catch(() => setError("Previous transaction on-chain status cannot be verified"));
  };
  const clearObsoleteRecords = () => {
    if (!wallet || !obsoletePending) return;
    for (const key of readObsoleteAttempts(window.localStorage, wallet).keys) window.localStorage.removeItem(key);
    setObsoletePending(false);
  };
  const clearInvalidAttempt = () => {
    if (!wallet || attempt || attemptStatus !== "manual-review") return;
    window.localStorage.removeItem(selectedAttemptKey(wallet)); setAttemptStatus(null);
  };
  return { wallet, connected, connect, disconnect, isMobile, walletsCount, connectionError,
    discovery, selection, state: visibleState, amount, tolerancePercent, result: displayedResult, attempt,
    attemptStatus, obsoletePending, error: error || quoteError, quoteError, busy, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled, walletBlocked, primaryAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation, retryReconcile, retryObsoleteReconcile, clearObsoleteRecords,
    clearInvalidAttempt };
}
