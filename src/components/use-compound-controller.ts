"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { clearsSubmitError, mayStartAnotherAttempt, type AtomicStatus } from "@/lib/attempt-status";
import { prepareIsStale } from "@/lib/fresh-blockhash";
import { ApiRequestError, resolveCompoundBroadcastFailure } from "@/lib/public-error";
import { abandonUnsentCompoundAttempt, compoundAttemptKey, loadCompoundAttempt, loadCompoundReceipts, persistCompoundAttempt, persistCompoundReceipt,
  removeConsumedCompoundReceipts, removeRecoveredReceipt, removeUnconfirmedCompoundReceipt, signedCompoundTransaction,
  type CompoundAttempt, type CompoundPrepared, type CompoundReceipt, type RecoveryPrepared } from "@/lib/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState, CompoundSummary } from "@/lib/compound-types";
import type { CompoundRecoverySummary } from "@/lib/compound-recovery-types";
import { useWalletConnection } from "./wallet-connection";

export type CompoundConfirmation = { status: AtomicStatus; signature: string; state: CompoundPositionState | null;
  chainStatus?: CompoundChainStatus;
  receipt?: { harvestedA: string; harvestedB: string; investedA: string; investedB: string;
    remainingA: string; remainingB: string; rewards: { mint: string; amount: string; compounded: boolean }[] };
  transactionError?: unknown };
type Options = { wallet?: string; positionMint?: string; externalBlocked: boolean; onConfirmed?: () => void };
type CompoundErrorState = { message: string; identity: string | null; signature: string | null; receiptSignature: string | null };
const emptyError: CompoundErrorState = { message: "", identity: null, signature: null, receiptSignature: null };
const statusValues: AtomicStatus[] = ["pending", "expired", "failed", "success", "manual-review"];
const chainStatusValues: CompoundChainStatus[] = ["pending", "expired", "failed", "success", "unknown"];
const slowConfirmationMs = 30_000;

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal });
  const value = await response.json() as T & { error?: string; sent?: boolean };
  if (!response.ok) {
    throw new ApiRequestError(value.error || "Unable to complete on-chain query, please retry later",
      value.sent === false ? false : undefined);
  }
  return value;
}

export function useCompoundController({ wallet, positionMint, externalBlocked, onConfirmed }: Options) {
  const connection = useWalletConnection();
  const [state, setState] = useState<CompoundPositionState | null>(null);
  const [preview, setPreview] = useState<CompoundSummary | null>(null);
  const [attempt, setAttempt] = useState<CompoundAttempt | null>(null);
  const [attemptStatus, setAttemptStatus] = useState<AtomicStatus | null>(null);
  const [chainStatus, setChainStatus] = useState<CompoundChainStatus | null>(null);
  const [confirmationSlow, setConfirmationSlow] = useState(false);
  const [confirmation, setConfirmation] = useState<CompoundConfirmation | null>(null);
  const [receipts, setReceipts] = useState<CompoundReceipt[]>([]);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [storageInvalid, setStorageInvalid] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [errorState, setErrorState] = useState<CompoundErrorState>(emptyError);
  const setError = useCallback((message: string, identity: string | null = null, signature: string | null = null, receiptSignature: string | null = null) =>
    setErrorState({ message, identity, signature, receiptSignature }), []);
  const clearError = useCallback((identity: string, signature: string | null = null) => setErrorState(previous =>
    previous.identity === identity && previous.signature === signature ? emptyError : previous), []);
  const [stage, setStage] = useState<"preparing" | "wallet" | "broadcasting" | null>(null);
  const identity = `${wallet || ""}:${positionMint || ""}`;
  const identityRef = useRef(identity);
  const walletRef = useRef(wallet);
  const externalBlockedRef = useRef(externalBlocked);
  const onConfirmedRef = useRef(onConfirmed);
  const connectionRef = useRef(connection);
  const stateRequest = useRef(0);
  const confirmationRequest = useRef(0);
  const submitting = useRef(false);
  const operationRequest = useRef(0);
  const attemptSignatureRef = useRef<string | null>(null);
  const previousTerminal = useRef<string | null>(null);
  const keepSubmitErrorRef = useRef(false);
  useLayoutEffect(() => {
    identityRef.current = identity; walletRef.current = wallet;
    externalBlockedRef.current = externalBlocked; onConfirmedRef.current = onConfirmed;
    connectionRef.current = connection;
  }, [identity, wallet, externalBlocked, onConfirmed, connection]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreview(null); setConfirmation(null); setChainStatus(null); setConfirmationSlow(false); setError(""); keepSubmitErrorRef.current = false;
      if (!wallet) { setAttempt(null); setAttemptStatus(null); setReceipts([]); setLoadedWallet(null); setStorageInvalid(false); attemptSignatureRef.current = null; return; }
      try {
        const saved = loadCompoundAttempt(window.localStorage, wallet);
        const savedReceipts = loadCompoundReceipts(window.localStorage, wallet);
        if (cancelled || walletRef.current !== wallet) return;
        setAttempt(saved.attempt); setReceipts(savedReceipts.receipts);
        attemptSignatureRef.current = saved.attempt?.signature || null;
        setStorageInvalid(saved.invalid || savedReceipts.invalid);
        setAttemptStatus(saved.invalid || savedReceipts.invalid ? "manual-review" : saved.attempt ? "pending" : null);
        if (saved.invalid || savedReceipts.invalid) setError("Local compound history cannot be verified. Check the original transaction and balance accounts before repeating an earlier operation.");
        setLoadedWallet(wallet);
      } catch {
        if (!cancelled && walletRef.current === wallet) {
          setAttempt(null); setAttemptStatus("manual-review"); setReceipts([]); setLoadedWallet(wallet); setStorageInvalid(true);
          setError("Unable to read local compound history. Check previous signatures before repeating an earlier operation.");
        }
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [wallet, setError]);

  const refreshState = useCallback(async () => {
    const requestedWallet = wallet;
    const requestedMint = positionMint;
    const requestId = ++stateRequest.current;
    if (!requestedWallet || !requestedMint) { setState(null); setLoading(false); return; }
    const requestedIdentity = `${requestedWallet}:${requestedMint}`;
    setLoading(true);
    try {
      const next = await post<CompoundPositionState>("/api/compound-state", { wallet: requestedWallet, positionMint: requestedMint });
      if (identityRef.current !== requestedIdentity || requestId !== stateRequest.current) return;
      if (next.wallet !== requestedWallet || next.positionMint !== requestedMint) throw new Error("Yield reading does not match selected position");
      setState(next);
      if (!keepSubmitErrorRef.current) clearError(requestedIdentity);
    } catch (caught) {
      if (identityRef.current === requestedIdentity && requestId === stateRequest.current) {
        // Keep the last yield snapshot so a transient RPC failure (skipped slot,
        // getBlockTime) cannot grey out One-click compound. Do not overwrite a
        // broadcast/prepare error that expired confirm must still show.
        if (!keepSubmitErrorRef.current) setError(caught instanceof Error ? caught.message : "Yield reading failed", requestedIdentity);
      }
    } finally {
      if (identityRef.current === requestedIdentity && requestId === stateRequest.current) setLoading(false);
    }
  }, [wallet, positionMint, clearError, setError]);
  useEffect(() => {
    stateRequest.current++;
    const timer = window.setTimeout(() => { setState(null); setPreview(null); void refreshState(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  const reconcile = useCallback(async (current: CompoundAttempt) => {
    const requestId = ++confirmationRequest.current;
    try {
    const checked = await post<CompoundConfirmation>("/api/compound-confirm", { wallet: current.wallet, attempt: current });
    if (walletRef.current !== current.wallet || attemptSignatureRef.current !== current.signature || requestId !== confirmationRequest.current) return;
    if (checked.signature !== current.signature || !statusValues.includes(checked.status) ||
      checked.chainStatus !== undefined && !chainStatusValues.includes(checked.chainStatus)) throw new Error("Transaction verification returned signature or status mismatch");
    // The chain result belongs to the stored attempt, regardless of the currently selected NFT.
    setAttemptStatus(checked.status); setConfirmation(checked);
    setChainStatus(checked.chainStatus ?? null);
    if (checked.status === "success" || checked.status === "failed" || checked.status === "expired") {
      if (clearsSubmitError(checked.status)) {
        clearError(`${current.wallet}:${current.positionMint}`, current.signature);
      }
      if ((checked.status === "failed" || checked.status === "expired") && current.kind === "compound") {
        removeUnconfirmedCompoundReceipt(window.localStorage, current);
        setReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
      }
      if (checked.status === "success" && current.kind === "recovery") {
        removeRecoveredReceipt(window.localStorage, current);
        setReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
      }
      if (checked.status === "success" && current.kind === "compound") {
        removeConsumedCompoundReceipts(window.localStorage, current);
        setReceipts(loadCompoundReceipts(window.localStorage, current.wallet).receipts);
      }
    }
    const executed = checked.chainStatus === "success" || checked.status === "success";
    if (executed || checked.status === "failed" || checked.status === "expired") {
      const terminal = `${current.signature}:${checked.chainStatus ?? checked.status}`;
      if (previousTerminal.current !== terminal) {
        previousTerminal.current = terminal;
        void refreshState(); onConfirmedRef.current?.();
      }
    }
    } catch (caught) {
      if (walletRef.current === current.wallet && attemptSignatureRef.current === current.signature &&
        requestId === confirmationRequest.current && !keepSubmitErrorRef.current) {
        setError(caught instanceof Error ? caught.message : "Verification failed, original signature retained", `${current.wallet}:${current.positionMint}`, current.signature);
      }
    }
  }, [refreshState, clearError, setError]);
  const chainSettled = chainStatus === "success" || chainStatus === "failed" || chainStatus === "expired";
  const transactionUnresolved = !!attempt && attempt.wallet === wallet && !chainSettled && !mayStartAnotherAttempt(attemptStatus);
  useEffect(() => {
    if (!attempt || !transactionUnresolved) return;
    let cancelled = false;
    let checking = false;
    const run = () => {
      if (checking || cancelled || attemptSignatureRef.current !== attempt.signature) return;
      checking = true;
      void reconcile(attempt).finally(() => { checking = false; });
    };
    const initial = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 4_000);
    // Thirty seconds changes historical feedback and triggers a read-only recheck.
    const slow = window.setTimeout(() => { if (attemptSignatureRef.current !== attempt.signature) return; setConfirmationSlow(true); run(); },
      Math.max(0, slowConfirmationMs - (Date.now() - attempt.createdAt)));
    return () => { cancelled = true; window.clearTimeout(initial); window.clearInterval(poll); window.clearTimeout(slow); };
  }, [attempt, transactionUnresolved, wallet, reconcile, setError]);

  const visibleState = state && state.wallet === wallet && state.positionMint === positionMint ? state : null;
  const visiblePreview = preview && preview.state.wallet === wallet && preview.positionMint === positionMint ? preview : null;
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  const busy = stage !== null;
  const walletBlocked = busy;
  const receiptReviewRequired = chainStatus === "success" && attemptStatus !== "success";
  const priorReceipts = loadedWallet === wallet ? receipts.filter((receipt) => receipt.positionMint === positionMint) : [];
  // Only the currently verified successful receipt may be reused automatically.
  // Older or unresolved accounts remain available through explicit recovery.
  const sourceSignatures = [...new Set(priorReceipts.filter((receipt) =>
    attemptStatus === "success" && receipt.sourceSignature === visibleAttempt?.signature)
    .map((receipt) => receipt.sourceSignature))];
  const hasFees = (visibleState ? BigInt(visibleState.fees.a) > 0n || BigInt(visibleState.fees.b) > 0n ||
    visibleState.rewards.some((reward) => BigInt(reward.estimatedAmount) > 0n) : false) || sourceSignatures.length > 0;
  const canCompound = !!wallet && !!positionMint && connection.connected &&
    !!visibleState?.eligible && hasFees && !externalBlocked && !walletBlocked;

  async function submit(receipt?: CompoundReceipt) {
    if (!wallet || (!receipt && !positionMint) || !connection.connected || submitting.current || externalBlockedRef.current || walletBlocked ||
      (!receipt && !canCompound) || (receipt && receipt.wallet !== wallet)) return;
    submitting.current = true; operationRequest.current++;
    confirmationRequest.current++; attemptSignatureRef.current = null;
    const submittedWallet = wallet;
    const submittedMint = receipt?.positionMint || positionMint!;
    const submittedIdentity = identity;
    const current = () => identityRef.current === submittedIdentity && walletRef.current === submittedWallet &&
      connectionRef.current.address === submittedWallet && connectionRef.current.connected;
    setStage("preparing"); setError(""); setConfirmation(null); keepSubmitErrorRef.current = false;
    let persisted = false;
    let next: CompoundAttempt | undefined;
    try {
      const requestPrepare = () => receipt
        ? post<RecoveryPrepared>("/api/compound-recover-prepare", { wallet: submittedWallet, compoundAccounts: receipt.compoundAccounts })
        : post<CompoundPrepared>("/api/compound-prepare", { wallet: submittedWallet, positionMint: submittedMint, sourceSignatures });
      const acceptPrepared = (prepared: CompoundPrepared | RecoveryPrepared) => {
        if (!current() || externalBlockedRef.current) throw new Error("Wallet or position changed; transaction not yet signed");
        const summary = prepared.summary;
        if (!prepared.permit || !summary.simulated || Date.now() >= summary.expiresAt ||
          (receipt ? summary.operation !== "recovery" || (summary as CompoundRecoverySummary).wallet !== wallet :
            summary.operation !== "compound" || (summary as CompoundSummary).state.wallet !== wallet ||
            (summary as CompoundSummary).positionMint !== positionMint)) throw new Error("Simulation result and selection mismatch or expired");
        const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (item) => item.charCodeAt(0)));
        if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.recentBlockhash !== summary.blockhash) {
          throw new Error("Transaction payer or blockhash and preparation result mismatch");
        }
        return { prepared, summary, unsigned };
      };
      let loaded = acceptPrepared(await requestPrepare());
      if (prepareIsStale(loaded.summary)) loaded = acceptPrepared(await requestPrepare());
      if (!receipt) setPreview(loaded.summary as CompoundSummary);
      const { prepared, summary, unsigned } = loaded;
      const originalMessage = Uint8Array.from(unsigned.message.serialize());
      setStage("wallet");
      const signed = await connectionRef.current.signTransaction(unsigned);
      const signedResult = signedCompoundTransaction(signed, originalMessage, submittedWallet);
      if (!current() || Date.now() >= summary.expiresAt || externalBlockedRef.current) {
        throw new Error("Wallet, position, or authorization changed during signing; transaction not broadcast");
      }
      const base = { version: 1 as const, wallet: submittedWallet, positionMint: receipt?.positionMint || submittedMint,
        signature: signedResult.signature, createdAt: Date.now() };
      const created: CompoundAttempt = receipt
        ? { ...base, kind: "recovery", summary: summary as CompoundRecoverySummary, sourceSignature: receipt.sourceSignature }
        : { ...base, kind: "compound", summary: summary as CompoundSummary };
      next = created;
      persistCompoundAttempt(window.localStorage, created);
      persisted = true;
      confirmationRequest.current++;
      attemptSignatureRef.current = created.signature;
      setAttempt(created); setAttemptStatus("pending"); setChainStatus("pending"); setConfirmationSlow(false);
      setReceipts(loadCompoundReceipts(window.localStorage, submittedWallet).receipts);
      setStage("broadcasting");
      const response = await post<{ signature: string }>(receipt ? "/api/compound-recover-broadcast" : "/api/compound-broadcast", {
        wallet: submittedWallet, positionMint: created.positionMint, summary, permit: prepared.permit,
        signedTransaction: signedResult.signedTransaction,
      }, AbortSignal.timeout(15_000));
      if (response.signature !== created.signature) throw new Error("Broadcast returned inconsistent signature; retain original signature and check on-chain result");
      void reconcile(created);
    } catch (caught) {
      if (walletRef.current === submittedWallet) {
        const message = caught instanceof Error ? caught.message : "Transaction not confirmed, verify signature first";
        const sent = caught instanceof ApiRequestError ? caught.sent : undefined;
        const outcome = resolveCompoundBroadcastFailure({ persisted, sent, message });
        if (outcome.abandon && next) {
          confirmationRequest.current++;
          attemptSignatureRef.current = null;
          abandonUnsentCompoundAttempt(window.localStorage, next);
          setAttempt(null); setAttemptStatus(null); setConfirmation(null); setChainStatus(null); setConfirmationSlow(false);
          setReceipts(loadCompoundReceipts(window.localStorage, submittedWallet).receipts);
          keepSubmitErrorRef.current = true;
          setError(outcome.error, `${submittedWallet}:${submittedMint}`, next.signature, receipt?.sourceSignature ?? null);
        } else if (outcome.keepPending) {
          keepSubmitErrorRef.current = false;
          setError("");
        } else {
          keepSubmitErrorRef.current = true;
          setError(outcome.error, `${submittedWallet}:${submittedMint}`, next?.signature ?? null, receipt?.sourceSignature ?? null);
        }
      }
    } finally {
      submitting.current = false;
      if (!persisted && walletRef.current === submittedWallet && attemptSignatureRef.current === null) {
        attemptSignatureRef.current = attempt?.signature ?? null;
      }
      setStage(null);
    }
  }

  const retryReconcile = () => {
    if (busy || !visibleAttempt) return;
    attemptSignatureRef.current = visibleAttempt.signature;
    void reconcile(visibleAttempt);
  };
  const canImport = !!wallet && !busy && !importing;
  async function importReceipt(signature: string) {
    if (!wallet || !canImport || submitting.current) return;
    const requestedWallet = wallet;
    const requestedOperation = operationRequest.current;
    const requestedSignature = signature.trim();
    const requestedIdentity = identity;
    setImporting(true); setError("");
    try {
      const response = await post<{ receipt: CompoundReceipt }>("/api/compound-recover-import", {
        wallet: requestedWallet, signature: requestedSignature,
      });
      if (walletRef.current !== requestedWallet || operationRequest.current !== requestedOperation) return;
      if (response.receipt.wallet !== requestedWallet || response.receipt.sourceSignature !== requestedSignature) {
        throw new Error("Yield account and query wallet or transaction signature mismatch");
      }
      persistCompoundReceipt(window.localStorage, response.receipt);
      setReceipts(loadCompoundReceipts(window.localStorage, requestedWallet).receipts);
    } catch (caught) {
      if (walletRef.current === requestedWallet && operationRequest.current === requestedOperation) setError(caught instanceof Error ? caught.message : "Yield account query failed", requestedIdentity);
    } finally { setImporting(false); }
  }
  return { wallet, positionMint, state: visibleState, preview: visiblePreview, attempt: visibleAttempt, attemptStatus,
    confirmation: visibleAttempt && confirmation?.signature === visibleAttempt.signature ? confirmation : null,
    receipts: loadedWallet === wallet ? receipts : [],
    error: !errorState.receiptSignature && (errorState.identity === null || errorState.identity === identity) ? errorState.message : "",
    recoveryError: wallet && errorState.receiptSignature && errorState.identity?.startsWith(`${wallet}:`)
      ? { sourceSignature: errorState.receiptSignature, message: errorState.message } : null,
    attemptError: visibleAttempt && errorState.identity === `${visibleAttempt.wallet}:${visibleAttempt.positionMint}` &&
      errorState.signature === visibleAttempt.signature ? errorState.message : "",
    loading, busy, stage, walletBlocked, externalBlocked,
    historyWarning: storageInvalid ? "Local compound history cannot be verified. Check previous signatures and balance accounts before repeating an earlier operation."
      : transactionUnresolved ? "A previous compound transaction is unresolved. Verify its signature before repeating that operation; new transactions are available."
      : receiptReviewRequired ? "A previous compound transaction finalized, but its yield details need verification. New transactions are available." : "",
    receiptReviewRequired, confirmationSlow: confirmationSlow && transactionUnresolved,
    canCompound, hasFees, priorReceipts, importing, canImport, importReceipt,
    ready: !!wallet && connection.connected && !walletBlocked && !externalBlocked,
    refreshState, compound: () => { void submit(); }, recover: (receipt: CompoundReceipt) => { void submit(receipt); }, retryReconcile,
    storageKey: wallet ? compoundAttemptKey(wallet) : null };
}

export type CompoundController = ReturnType<typeof useCompoundController>;
