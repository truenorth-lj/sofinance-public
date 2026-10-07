"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { mayStartAnotherAttempt, type AtomicStatus } from "@/lib/attempt-status";
import { compoundAttemptKey, loadCompoundAttempt, loadCompoundReceipts, persistCompoundAttempt, persistCompoundReceipt,
  removeConsumedCompoundReceipts, removeRecoveredReceipt, removeUnconfirmedCompoundReceipt, signedCompoundTransaction,
  type CompoundAttempt, type CompoundPrepared, type CompoundReceipt, type RecoveryPrepared } from "@/lib/compound-attempt";
import type { CompoundPositionState, CompoundSummary } from "@/lib/compound-types";
import type { CompoundRecoverySummary } from "@/lib/compound-recovery-types";
import { useWalletConnection } from "./wallet-connection";

export type CompoundConfirmation = { status: AtomicStatus; signature: string; state: CompoundPositionState | null;
  receipt?: { harvestedA: string; harvestedB: string; investedA: string; investedB: string;
    remainingA: string; remainingB: string; rewards: { mint: string; amount: string; compounded: boolean }[] };
  transactionError?: unknown };
type Options = { wallet?: string; positionMint?: string; externalBlocked: boolean; onConfirmed?: () => void };
const statusValues: AtomicStatus[] = ["pending", "expired", "failed", "success", "manual-review"];

async function post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), cache: "no-store", signal });
  const value = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(value.error || "Unable to complete on-chain query, please retry later");
  return value;
}

export function useCompoundController({ wallet, positionMint, externalBlocked, onConfirmed }: Options) {
  const connection = useWalletConnection();
  const [state, setState] = useState<CompoundPositionState | null>(null);
  const [preview, setPreview] = useState<CompoundSummary | null>(null);
  const [attempt, setAttempt] = useState<CompoundAttempt | null>(null);
  const [attemptStatus, setAttemptStatus] = useState<AtomicStatus | null>(null);
  const [confirmation, setConfirmation] = useState<CompoundConfirmation | null>(null);
  const [receipts, setReceipts] = useState<CompoundReceipt[]>([]);
  const [loadedWallet, setLoadedWallet] = useState<string | null>(null);
  const [storageInvalid, setStorageInvalid] = useState(false);
  const [importing, setImporting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
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
  const attemptSignatureRef = useRef<string | null>(null);
  const previousTerminal = useRef<string | null>(null);
  useLayoutEffect(() => {
    identityRef.current = identity; walletRef.current = wallet;
    externalBlockedRef.current = externalBlocked; onConfirmedRef.current = onConfirmed;
    connectionRef.current = connection;
  }, [identity, wallet, externalBlocked, onConfirmed, connection]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setPreview(null); setConfirmation(null); setError("");
      if (!wallet) { setAttempt(null); setAttemptStatus(null); setReceipts([]); setLoadedWallet(null); setStorageInvalid(false); attemptSignatureRef.current = null; return; }
      try {
        const saved = loadCompoundAttempt(window.localStorage, wallet);
        const savedReceipts = loadCompoundReceipts(window.localStorage, wallet);
        if (cancelled || walletRef.current !== wallet) return;
        setAttempt(saved.attempt); setReceipts(savedReceipts.receipts);
        attemptSignatureRef.current = saved.attempt?.signature || null;
        setStorageInvalid(saved.invalid || savedReceipts.invalid);
        setAttemptStatus(saved.invalid || savedReceipts.invalid ? "manual-review" : saved.attempt ? "pending" : null);
        if (saved.invalid || savedReceipts.invalid) setError("Local compound records cannot be verified; please verify original transaction and balance accounts, new transactions paused");
        setLoadedWallet(wallet);
      } catch {
        if (!cancelled && walletRef.current === wallet) {
          setAttempt(null); setAttemptStatus("manual-review"); setReceipts([]); setLoadedWallet(wallet); setStorageInvalid(true);
          setError("Unable to read local transaction records; new transactions paused to avoid duplicate submission");
        }
      }
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [wallet]);

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
      setState(next); setError("");
    } catch (caught) {
      if (identityRef.current === requestedIdentity && requestId === stateRequest.current) {
        // Keep the last yield snapshot so a transient RPC failure (skipped slot,
        // getBlockTime) cannot grey out One-click compound.
        setError(caught instanceof Error ? caught.message : "Yield reading failed");
      }
    } finally {
      if (identityRef.current === requestedIdentity && requestId === stateRequest.current) setLoading(false);
    }
  }, [wallet, positionMint]);
  useEffect(() => {
    stateRequest.current++;
    const timer = window.setTimeout(() => { setState(null); setPreview(null); void refreshState(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  const reconcile = useCallback(async (current: CompoundAttempt) => {
    const requestId = ++confirmationRequest.current;
    const checked = await post<CompoundConfirmation>("/api/compound-confirm", { wallet: current.wallet, attempt: current });
    if (walletRef.current !== current.wallet || attemptSignatureRef.current !== current.signature || requestId !== confirmationRequest.current) return;
    if (checked.signature !== current.signature || !statusValues.includes(checked.status)) throw new Error("Transaction verification returned signature or status mismatch");
    // The chain result belongs to the stored attempt, regardless of the currently selected NFT.
    setAttemptStatus(checked.status); setConfirmation(checked);
    if (checked.status === "success" || checked.status === "failed" || checked.status === "expired") {
      setError("");
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
      const terminal = `${current.signature}:${checked.status}`;
      if (previousTerminal.current !== terminal) {
        previousTerminal.current = terminal;
        void refreshState(); onConfirmedRef.current?.();
      }
    }
  }, [refreshState]);
  useEffect(() => {
    if (!attempt || attempt.wallet !== wallet || attemptStatus !== "pending") return;
    let cancelled = false;
    let checking = false;
    const run = () => {
      if (checking || cancelled) return;
      checking = true;
      void reconcile(attempt).catch((caught) => {
      if (!cancelled && walletRef.current === attempt.wallet) setError(caught instanceof Error ? caught.message : "Transaction verification failed, please retain signature");
      }).finally(() => { checking = false; });
    };
    const initial = window.setTimeout(run, 0);
    const poll = window.setInterval(run, 4_000);
    return () => { cancelled = true; window.clearTimeout(initial); window.clearInterval(poll); };
  }, [attempt, attemptStatus, wallet, reconcile]);

  const visibleState = state && state.wallet === wallet && state.positionMint === positionMint ? state : null;
  const visiblePreview = preview && preview.state.wallet === wallet && preview.positionMint === positionMint ? preview : null;
  const visibleAttempt = attempt?.wallet === wallet ? attempt : null;
  const busy = stage !== null;
  const walletBlocked = Boolean(wallet && (loadedWallet !== wallet || storageInvalid || busy || !mayStartAnotherAttempt(attemptStatus)));
  const priorReceipts = loadedWallet === wallet ? receipts.filter((receipt) => receipt.positionMint === positionMint) : [];
  const skipOrphanSignature = visibleAttempt && (attemptStatus === "expired" || attemptStatus === "failed")
    ? visibleAttempt.signature : undefined;
  const sourceSignatures = [...new Set(priorReceipts.filter((receipt) => receipt.sourceSignature !== skipOrphanSignature)
    .map((receipt) => receipt.sourceSignature))];
  const hasFees = (visibleState ? BigInt(visibleState.fees.a) > 0n || BigInt(visibleState.fees.b) > 0n ||
    visibleState.rewards.some((reward) => BigInt(reward.estimatedAmount) > 0n) : false) || sourceSignatures.length > 0;
  const canCompound = !!wallet && !!positionMint && connection.connected && loadedWallet === wallet &&
    !!visibleState?.eligible && hasFees && !externalBlocked && !walletBlocked;

  async function submit(receipt?: CompoundReceipt) {
    if (!wallet || (!receipt && !positionMint) || !connection.connected || submitting.current || externalBlockedRef.current || walletBlocked ||
      (!receipt && !canCompound) || (receipt && receipt.wallet !== wallet)) return;
    submitting.current = true;
    const submittedWallet = wallet;
    const submittedMint = receipt?.positionMint || positionMint!;
    const submittedIdentity = identity;
    const current = () => identityRef.current === submittedIdentity && walletRef.current === submittedWallet &&
      connectionRef.current.address === submittedWallet && connectionRef.current.connected;
    setStage("preparing"); setError(""); setConfirmation(null);
    try {
      const prepared = receipt
        ? await post<RecoveryPrepared>("/api/compound-recover-prepare", { wallet: submittedWallet, compoundAccounts: receipt.compoundAccounts })
        : await post<CompoundPrepared>("/api/compound-prepare", { wallet: submittedWallet, positionMint: submittedMint, sourceSignatures });
      if (!current() || externalBlockedRef.current) throw new Error("Wallet or position changed; transaction not yet signed");
      const summary = prepared.summary;
      if (!prepared.permit || !summary.simulated || Date.now() >= summary.expiresAt ||
        (receipt ? summary.operation !== "recovery" || (summary as CompoundRecoverySummary).wallet !== wallet :
          summary.operation !== "compound" || (summary as CompoundSummary).state.wallet !== wallet ||
          (summary as CompoundSummary).positionMint !== positionMint)) throw new Error("Simulation result and selection mismatch or expired");
      if (!receipt) setPreview(summary as CompoundSummary);
      const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (item) => item.charCodeAt(0)));
      if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.recentBlockhash !== summary.blockhash) {
        throw new Error("Transaction payer or blockhash and preparation result mismatch");
      }
      const originalMessage = Uint8Array.from(unsigned.message.serialize());
      setStage("wallet");
      const signed = await connectionRef.current.signTransaction(unsigned);
      const signedResult = signedCompoundTransaction(signed, originalMessage, submittedWallet);
      if (!current() || Date.now() >= summary.expiresAt || externalBlockedRef.current) {
        throw new Error("Wallet, position, or authorization changed during signing; transaction not broadcast");
      }
      const base = { version: 1 as const, wallet: submittedWallet, positionMint: receipt?.positionMint || submittedMint,
        signature: signedResult.signature, createdAt: Date.now() };
      const next: CompoundAttempt = receipt
        ? { ...base, kind: "recovery", summary: summary as CompoundRecoverySummary, sourceSignature: receipt.sourceSignature }
        : { ...base, kind: "compound", summary: summary as CompoundSummary };
      persistCompoundAttempt(window.localStorage, next);
      confirmationRequest.current++;
      attemptSignatureRef.current = next.signature;
      setAttempt(next); setAttemptStatus("pending");
      setReceipts(loadCompoundReceipts(window.localStorage, submittedWallet).receipts);
      setStage("broadcasting");
      const response = await post<{ signature: string }>(receipt ? "/api/compound-recover-broadcast" : "/api/compound-broadcast", {
        wallet: submittedWallet, positionMint: next.positionMint, summary, permit: prepared.permit,
        signedTransaction: signedResult.signedTransaction,
      });
      if (response.signature !== next.signature) throw new Error("Broadcast returned inconsistent signature; retain original signature and check on-chain result");
      await reconcile(next);
    } catch (caught) {
      if (walletRef.current === submittedWallet) setError(caught instanceof Error ? caught.message : "Transaction not confirmed, verify signature first");
    } finally { submitting.current = false; setStage(null); }
  }

  const retryReconcile = () => {
    if (visibleAttempt) void reconcile(visibleAttempt).catch((caught) => {
      if (walletRef.current === visibleAttempt.wallet) setError(caught instanceof Error ? caught.message : "Verification failed, original signature retained");
    });
  };
  const canImport = !!wallet && loadedWallet === wallet && !storageInvalid && !busy && !importing;
  async function importReceipt(signature: string) {
    if (!wallet || !canImport) return;
    const requestedWallet = wallet;
    const requestedSignature = signature.trim();
    setImporting(true); setError("");
    try {
      const response = await post<{ receipt: CompoundReceipt }>("/api/compound-recover-import", {
        wallet: requestedWallet, signature: requestedSignature,
      });
      if (walletRef.current !== requestedWallet) return;
      if (response.receipt.wallet !== requestedWallet || response.receipt.sourceSignature !== requestedSignature) {
        throw new Error("Yield account and query wallet or transaction signature mismatch");
      }
      persistCompoundReceipt(window.localStorage, response.receipt);
      setReceipts(loadCompoundReceipts(window.localStorage, requestedWallet).receipts);
    } catch (caught) {
      if (walletRef.current === requestedWallet) setError(caught instanceof Error ? caught.message : "Yield account query failed");
    } finally { setImporting(false); }
  }
  return { wallet, positionMint, state: visibleState, preview: visiblePreview, attempt: visibleAttempt, attemptStatus,
    confirmation: visibleAttempt && confirmation?.signature === visibleAttempt.signature ? confirmation : null,
    receipts: loadedWallet === wallet ? receipts : [], error, loading, busy, stage, walletBlocked, externalBlocked,
    canCompound, hasFees, priorReceipts, importing, canImport, importReceipt,
    ready: !!wallet && connection.connected && loadedWallet === wallet && !walletBlocked && !externalBlocked,
    refreshState, compound: () => { void submit(); }, recover: (receipt: CompoundReceipt) => { void submit(receipt); }, retryReconcile,
    storageKey: wallet ? compoundAttemptKey(wallet) : null };
}

export type CompoundController = ReturnType<typeof useCompoundController>;
