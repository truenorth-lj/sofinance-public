"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { formatAmount, parseTokenAmount, toleranceFromPercent } from "@sofinance/engine/amount";
import { type AtomicStatus } from "@/lib/attempt-status";
import { loadSelectedAttempt, persistSelectedAttempt, readSelectedHistory, type SelectedAttempt } from "@/lib/selected-attempt";
import { readObsoleteAttempts } from "@/lib/obsolete-attempt";
import type { SelectedQuote } from "@/lib/selected-quote";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";
import type { WalletDiscovery } from "@sofinance/engine/wallet-discovery";
import { DEFAULT_RESALE_FLOOR_BPS, USDC_MINT } from "@sofinance/engine/ids";
import { useWalletConnection } from "./wallet-connection";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";

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
  const [history, setHistory] = useState<SelectedAttempt[]>([]);
  const [verificationError, setVerificationError] = useState("");
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
  const attemptSignatureRef = useRef<string | null>(null);
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
        body: JSON.stringify({ signature: old.signature, lastValidBlockHeight: old.lastValidBlockHeight }), cache: "no-store",
        signal: AbortSignal.timeout(8_000) });
      if (!response.ok) throw new Error("Previous transaction could not be verified. Check its status before starting again.");
      const data = await response.json() as { status: "finalized" | "failed" | "expired" | "pending" };
      if (!["finalized", "failed", "expired"].includes(data.status)) pending = true;
    }
    return pending;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      reconcileRequestRef.current++;
      setVerificationError("");
      setHistory([]);
      if (!wallet) { setAttempt(null); attemptSignatureRef.current = null; setHistory([]); setAttemptStatus(null); setObsoletePending(false); setAttemptLoadedWallet(null); return; }
      try {
        const saved = loadSelectedAttempt(window.localStorage, wallet);
        setAttempt(saved.attempt);
        attemptSignatureRef.current = saved.attempt?.signature ?? null;
        setHistory(readSelectedHistory(window.localStorage, wallet));
        setAttemptStatus(saved.invalid ? "manual-review" : saved.attempt ? "pending" : null);
        const legacy = readObsoleteAttempts(window.localStorage, wallet);
        setObsoletePending(legacy.invalid || legacy.attempts.length > 0);
        setAttemptLoadedWallet(wallet);
      } catch {
        attemptSignatureRef.current = null;
        setAttempt(null); setAttemptStatus("manual-review"); setObsoletePending(true); setAttemptLoadedWallet(wallet);
      }
      // Old network lookups are independent of preview readiness.
      void reconcileObsolete(wallet).catch(() => true).then((pending) => {
        if (!cancelled && walletRef.current === wallet) setObsoletePending(pending);
      });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [wallet, reconcileObsolete]);

  const reconcileAttempt = useCallback(async (current: SelectedAttempt) => {
    const requestId = ++reconcileRequestRef.current;
    const ownsResult = () => walletRef.current === current.wallet && attemptSignatureRef.current === current.signature &&
      requestId === reconcileRequestRef.current;
    try {
    const response = await fetch("/api/selected-status", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: current.wallet, selection: current.selection, poolId: current.poolId,
        positionAccount: current.positionAccount, signature: current.signature,
        startingLiquidity: current.startingLiquidity, expectedLiquidity: current.expectedLiquidity,
        startingBalances: current.startingBalances, lastValidBlockHeight: current.lastValidBlockHeight }), cache: "no-store",
      signal: AbortSignal.timeout(8_000) });
    const data = await response.json() as StatusResponse | ApiError;
    if (!ownsResult()) return;
    if (!response.ok) throw new Error((data as ApiError).error);
    const checked = data as StatusResponse;
    if (checked.signature !== current.signature || !["pending", "expired", "failed", "success", "manual-review"].includes(checked.status)) {
      throw new Error("Transaction verification returned a different signature or invalid status");
    }
    setAttemptStatus(checked.status);
    if (checked.status === "success") notifyPositionHistoryChange(current.selection.positionMint, current.signature);
    setVerificationError("");
    } catch (caught) {
      if (ownsResult()) setVerificationError(caught instanceof Error ? caught.message : "Transaction status verification failed");
    }
  }, []);

  useEffect(() => {
    if (busy || !attempt || attempt.wallet !== wallet || ["success", "expired", "failed", "manual-review"].includes(attemptStatus || "")) return;
    let checking = false;
    const check = () => {
      if (checking) return;
      checking = true;
      void reconcileAttempt(attempt).finally(() => { checking = false; });
    };
    const timer = window.setTimeout(check, 0);
    const poll = window.setInterval(check, 4_000);
    return () => { window.clearTimeout(timer); window.clearInterval(poll); };
  }, [attempt, attemptStatus, busy, wallet, reconcileAttempt]);

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

  useEffect(() => {
    if (!ready || !wallet || !selection || toleranceBps === null || busy) return;
    const requestId = ++quoteRequestRef.current;
    const aborter = new AbortController();
    let cancelled = false;
    const key = selectionKey(selection);
    const requested = rawAmount.toString();
    let expiryTimer: number | undefined;
    let deadline: number | undefined;
    const scheduleRefresh = (expiresAt: number) => {
      expiryTimer = window.setTimeout(() => setQuoteRevision((current) => current + 1),
        Math.max(1_000, expiresAt - Date.now()));
    };
    const current = () => !cancelled && requestId === quoteRequestRef.current &&
      walletRef.current === wallet && selectionRef.current === key;
    const timer = window.setTimeout(() => {
      const load = async () => {
        setQuoteLoading(true); setPreview({ kind: "idle" }); setQuoteError("");
        deadline = window.setTimeout(() => aborter.abort(new Error("Preview took too long. Please retry.")), 8_000);
        try {
          const body = JSON.stringify({ wallet, ...selection, amount, floorBps, toleranceBps });
          const response = await fetch("/api/selected-quote", { method: "POST",
            headers: { "Content-Type": "application/json" }, body, cache: "no-store", signal: aborter.signal });
          const data = await response.json() as SelectedQuote | ApiError;
          if (!current() || aborter.signal.aborted) return;
          if (!response.ok) throw new Error((data as ApiError).error);
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
          if (current()) setQuoteError(aborter.signal.aborted ? "Preview took too long. Please retry." :
            caught instanceof Error ? caught.message : "Preview failed");
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
    };
  }, [amount, busy, floorBps, toleranceBps, quoteRevision, rawAmount, ready, selection, wallet]);

  async function signAndSend() {
    if (!ready || busy || submittingRef.current || quoteLoading || !quote || !fresh ||
      !wallet || !selection || !visibleState || toleranceBps === null) return;
    submittingRef.current = true;
    reconcileRequestRef.current++;
    attemptSignatureRef.current = null;
    const key = selectionKey(selection);
    const inputRevision = inputRevisionRef.current;
    setSubmitStage("preparing"); setError("");
    const aborter = new AbortController();
    const deadline = window.setTimeout(() => aborter.abort(new Error("Preparation took too long. Please retry.")), 8_000);
    try {
      const response = await fetch("/api/selected-prepare", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, ...selection, amount, floorBps, toleranceBps }), cache: "no-store", signal: aborter.signal });
      const data = await response.json() as Prepared | ApiError;
      window.clearTimeout(deadline);
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
      setPreview({ kind: "quoted", result: prepared }); setNow(Date.now());
      setSubmitStage("wallet");
      const originalMessage = unsigned.message.serialize();
      const signed = await signTransaction(unsigned);
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
      setHistory(readSelectedHistory(window.localStorage, wallet));
      attemptSignatureRef.current = signature;
      setAttempt(current); setAttemptStatus("pending"); setPreview({ kind: "idle" }); setSubmitStage("broadcasting");
      const sent = await fetch("/api/selected-broadcast", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wallet, selection, signedTransaction, permit: prepared.permit,
          requested: prepared.quote.requested, floorBps: prepared.quote.floorBps,
          expiresAt: prepared.expiresAt, lastValidBlockHeight: prepared.lastValidBlockHeight,
          startingLiquidity: prepared.startingLiquidity, expectedLiquidity: prepared.quote.liquidity,
          rangeSide: prepared.quote.rangeSide, startingBalances: prepared.startingBalances }), cache: "no-store",
        signal: AbortSignal.timeout(15_000) });
      const broadcast = await sent.json() as { signature?: string; error?: string };
      if (!sent.ok) throw new Error(broadcast.error || "Dedicated RPC rejected transaction; verify on-chain status");
      if (broadcast.signature !== signature) throw new Error("Dedicated RPC returned inconsistent transaction signature, check on-chain status");
      void reconcileAttempt(current);
      void refreshState();
    } catch (caught) {
      if (walletRef.current === wallet) setError(caught instanceof Error ? caught.message : "Transaction not confirmed; check on-chain status before proceeding");
    }
    finally {
      window.clearTimeout(deadline); submittingRef.current = false;
      if (walletRef.current === wallet && attemptSignatureRef.current === null) attemptSignatureRef.current = attempt?.signature ?? null;
      setSubmitStage(null);
    }
  }

  const actionLabel = submitStage === "preparing" ? "Preparing latest transaction…" : submitStage === "wallet" ?
    "Confirming in wallet…" : submitStage === "broadcasting" ? "Sending and verifying…" : "Add liquidity";
  const actionDisabled = busy || !ready || quoteLoading || !quote || !fresh;
  const walletBlocked = busy;
  const historyWarning = wallet && attemptLoadedWallet === wallet && (verificationError || obsoletePending ||
    attemptStatus === "pending" || attemptStatus === "manual-review")
    ? "Previous transaction is unconfirmed or needs verification. It may still succeed; starting again may add liquidity twice." : "";
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
  const retryReconcile = () => { if (attempt && !busy) void reconcileAttempt(attempt); };
  const retryObsoleteReconcile = () => {
    if (!wallet) return;
    void reconcileObsolete(wallet).then((pending) => { if (walletRef.current === wallet) setObsoletePending(pending); })
      .catch(() => setObsoletePending(true));
  };
  return { wallet, connected, connect, disconnect, isMobile, walletsCount, connectionError,
    discovery, selection, state: visibleState, amount, tolerancePercent, result: displayedResult, attempt,
    attemptStatus, obsoletePending, history: history.filter(item => item.wallet === wallet), historyWarning, verificationError,
    error: error || quoteError, quoteError, busy, calculating, now, floorBps, quote, fresh, status,
    actionLabel, actionDisabled, walletBlocked, primaryAction, changeAmount, changeTolerance, fillMax,
    choosePosition, chooseAsset, refreshDiscovery, refreshState, retryCalculation, retryReconcile, retryObsoleteReconcile,
    loadingDiscovery, loadingState, stateError };
}
