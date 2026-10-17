"use client";
import "@/lib/engine-host";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import { clearsSubmitError, mayStartAnotherAttempt, type AtomicStatus } from "@/lib/attempt-status";
import { prepareIsStale } from "@sofinance/engine/fresh-blockhash";
import { ApiRequestError, resolveCompoundBroadcastFailure } from "@/lib/public-error";
import { abandonUnsentCompoundAttempt, compoundAttemptKey, compoundReceiptsKey, loadCompoundAttempt, loadCompoundReceipts, persistCompoundAttempt, persistCompoundReceipt,
  removeConsumedCompoundReceipts, removeRecoveredReceipt, removeUnconfirmedCompoundReceipt, signedCompoundTransaction,
  type CompoundAttempt, type CompoundPrepared, type CompoundReceipt, type RecoveryPrepared } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus, CompoundPositionState, CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { useWalletConnection } from "./wallet-connection";
import { notifyPositionHistoryChange } from "@/lib/position-history-refresh";

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
type AlreadyClosedRecovery = { alreadyClosed: true; wallet: string; accounts: string[] };
const recoveryConfirmationMs = 90_000;
function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>(resolve => {
    if (signal.aborted) { resolve(); return; }
    const finish = () => { window.clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
type RecoveryOutcome = "success" | "stopped";
type DiscoveryPage = { wallet: string; receipts: CompoundReceipt[]; nextCursor: string | null; scanned: number;
  totalCandidates: number; incomplete: boolean; errors: number };
type CleanupProgress = { completed: number; total: number; running: boolean; message: string; compoundSignature?: string };
function recoveryMayProceed(value: { status: AtomicStatus; chainStatus?: CompoundChainStatus } | null) {
  return !!value && ["success", "failed", "expired"].includes(value.status) &&
    (value.chainStatus === undefined || value.chainStatus === value.status);
}
const emptyScan = { started: false, scanning: false, cursor: null as string | null, scanned: 0, total: 0, incomplete: false, error: "" };

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
  const [scan, setScan] = useState(emptyScan);
  const [cleanup, setCleanup] = useState<CleanupProgress | null>(null);
  const mounted = useRef(true);
  const lifecycle = useRef(0);
  const operationLifecycle = useRef(0);
  const recoveryWait = useRef<{ signature: string; controller: AbortController } | null>(null);
  const scanRequest = useRef(0);
  const scanRunning = useRef(false);
  const cleanupRunning = useRef(false);
  const autoCleanup = useRef<{ wallet: string; signature: string; identity: string } | null>(null);
  const resolvedAttempt = useRef<{ signature: string; status: AtomicStatus; chainStatus?: CompoundChainStatus } | null>(null);
  const runRecoveryRef = useRef<(items: CompoundReceipt[], signature?: string) => Promise<void>>(async () => {});
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
    if (walletRef.current !== wallet) scanRequest.current++;
    if (identityRef.current !== identity) { lifecycle.current++; autoCleanup.current = null; recoveryWait.current?.controller.abort(); }
    identityRef.current = identity; walletRef.current = wallet;
    externalBlockedRef.current = externalBlocked; onConfirmedRef.current = onConfirmed;
    connectionRef.current = connection;
  }, [identity, wallet, externalBlocked, onConfirmed, connection]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; autoCleanup.current = null; recoveryWait.current?.controller.abort(); };
  }, []);

  useEffect(() => {
    const selectedLifecycle = lifecycle.current;
    const timer = window.setTimeout(() => {
      if (lifecycle.current === selectedLifecycle && operationLifecycle.current !== selectedLifecycle) {
        setStage(null); setCleanup(null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [identity]);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setStage(null); setScan(emptyScan); setCleanup(null); scanRequest.current++; resolvedAttempt.current = null;
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
      if (!mounted.current || identityRef.current !== requestedIdentity || requestId !== stateRequest.current) return;
      if (next.wallet !== requestedWallet || next.positionMint !== requestedMint) throw new Error("Yield reading does not match selected position");
      setState(next);
      if (!keepSubmitErrorRef.current) clearError(requestedIdentity);
    } catch (caught) {
      if (mounted.current && identityRef.current === requestedIdentity && requestId === stateRequest.current) {
        // Keep the last yield snapshot so a transient RPC failure (skipped slot,
        // getBlockTime) cannot grey out One-click compound. Do not overwrite a
        // broadcast/prepare error that expired confirm must still show.
        if (!keepSubmitErrorRef.current) setError(caught instanceof Error ? caught.message : "Yield reading failed", requestedIdentity);
      }
    } finally {
      if (mounted.current && identityRef.current === requestedIdentity && requestId === stateRequest.current) setLoading(false);
    }
  }, [wallet, positionMint, clearError, setError]);
  useEffect(() => {
    stateRequest.current++;
    const timer = window.setTimeout(() => { setState(null); setPreview(null); void refreshState(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refreshState]);

  const reconcile = useCallback(async (current: CompoundAttempt, signal?: AbortSignal) => {
    const requestId = ++confirmationRequest.current;
    try {
    const checked = await post<CompoundConfirmation>("/api/compound-confirm", { wallet: current.wallet, attempt: current }, signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000));
    if (!mounted.current || walletRef.current !== current.wallet || attemptSignatureRef.current !== current.signature || requestId !== confirmationRequest.current) return null;
    if (checked.signature !== current.signature || !statusValues.includes(checked.status) ||
      checked.chainStatus !== undefined && !chainStatusValues.includes(checked.chainStatus)) throw new Error("Transaction verification returned signature or status mismatch");
    // The chain result belongs to the stored attempt, regardless of the currently selected NFT.
    resolvedAttempt.current = { signature: current.signature, status: checked.status, chainStatus: checked.chainStatus };
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
        if (executed) notifyPositionHistoryChange(current.positionMint, current.kind === "compound" ? current.signature : undefined);
        void refreshState(); onConfirmedRef.current?.();
      }
    }
    return checked;
    } catch (caught) {
      if (mounted.current && walletRef.current === current.wallet && attemptSignatureRef.current === current.signature &&
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
      if (checking || cancelled || recoveryWait.current?.signature === attempt.signature || attemptSignatureRef.current !== attempt.signature) return;
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
  const busy = stage !== null || !!cleanup?.running;
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

  async function submit(receipt?: CompoundReceipt, batch = false): Promise<RecoveryOutcome> {
    if (cleanupRunning.current && !batch) return "stopped";
    if (!wallet || (!receipt && !positionMint) || !connection.connected || submitting.current || externalBlockedRef.current || (walletBlocked && !batch) ||
      (!receipt && !canCompound) || (receipt && receipt.wallet !== wallet)) return "stopped";
    if (receipt) {
      const saved = loadCompoundAttempt(window.localStorage, wallet);
      if (saved.invalid || saved.attempt && (resolvedAttempt.current?.signature !== saved.attempt.signature ||
        !recoveryMayProceed(resolvedAttempt.current))) {
        setCleanup(previous => ({ completed: previous?.completed ?? 0, total: previous?.total ?? 1, running: false,
          message: "Cleanup paused. Verify the previous transaction before continuing.", compoundSignature: previous?.compoundSignature }));
        return "stopped";
      }
    }
    submitting.current = true; operationLifecycle.current = lifecycle.current; operationRequest.current++;
    confirmationRequest.current++; attemptSignatureRef.current = null;
    const submittedLifecycle = lifecycle.current;
    const submittedWallet = wallet;
    const submittedMint = receipt?.positionMint || positionMint!;
    const submittedIdentity = identity;
    const current = () => mounted.current && lifecycle.current === submittedLifecycle && identityRef.current === submittedIdentity && walletRef.current === submittedWallet &&
      connectionRef.current.address === submittedWallet && connectionRef.current.connected;
    setStage("preparing"); setError(""); setConfirmation(null); keepSubmitErrorRef.current = false;
    let persisted = false;
    let next: CompoundAttempt | undefined;
    try {
      const requestPrepare = () => receipt
        ? post<RecoveryPrepared | AlreadyClosedRecovery>("/api/compound-recover-prepare", { wallet: submittedWallet, compoundAccounts: receipt.compoundAccounts })
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
      const acceptClosed = (response: CompoundPrepared | RecoveryPrepared | AlreadyClosedRecovery) => {
        if (!("alreadyClosed" in response)) return false;
        if (!receipt || response.alreadyClosed !== true || response.wallet !== submittedWallet || !current() ||
          !Array.isArray(response.accounts) || response.accounts.length !== receipt.compoundAccounts.length ||
          [...response.accounts].sort().join(":") !== receipt.compoundAccounts.map(account => account.address).sort().join(":")) {
          throw new Error("Closed account verification does not match the selected yield accounts");
        }
        const saved = loadCompoundReceipts(window.localStorage, submittedWallet);
        if (saved.invalid) throw new Error("Local yield account records need verification before cleanup can continue");
        const key = compoundReceiptsKey(submittedWallet);
        const serialized = JSON.stringify(saved.receipts.filter(item => item.sourceSignature !== receipt.sourceSignature ||
          item.compoundAccounts.map(account => account.address).sort().join(":") !== [...response.accounts].sort().join(":")));
        window.localStorage.setItem(key, serialized);
        if (window.localStorage.getItem(key) !== serialized) throw new Error("Unable to save the cleaned account record");
        setReceipts(loadCompoundReceipts(window.localStorage, submittedWallet).receipts);
        return true;
      };
      let response = await requestPrepare();
      if (acceptClosed(response)) return "success";
      let loaded = acceptPrepared(response as CompoundPrepared | RecoveryPrepared);
      if (prepareIsStale(loaded.summary)) {
        response = await requestPrepare();
        if (acceptClosed(response)) return "success";
        loaded = acceptPrepared(response as CompoundPrepared | RecoveryPrepared);
      }
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
      resolvedAttempt.current = null;
      if (!receipt) autoCleanup.current = { wallet: submittedWallet, signature: created.signature, identity: submittedIdentity };
      persisted = true;
      confirmationRequest.current++;
      attemptSignatureRef.current = created.signature;
      setAttempt(created); setAttemptStatus("pending"); setChainStatus("pending"); setConfirmationSlow(false);
      setReceipts(loadCompoundReceipts(window.localStorage, submittedWallet).receipts);
      setStage("broadcasting");
      if (receipt) recoveryWait.current = { signature: created.signature, controller: new AbortController() };
      const broadcast = await post<{ signature: string }>(receipt ? "/api/compound-recover-broadcast" : "/api/compound-broadcast", {
        wallet: submittedWallet, positionMint: created.positionMint, summary, permit: prepared.permit,
        signedTransaction: signedResult.signedTransaction,
      }, AbortSignal.timeout(15_000));
      if (broadcast.signature !== created.signature) throw new Error("Broadcast returned inconsistent signature; retain original signature and check on-chain result");
      if (receipt) {
        const waiting = recoveryWait.current!;
        const timeout = window.setTimeout(() => waiting.controller.abort(), recoveryConfirmationMs);
        let stop!: () => void;
        const aborted = new Promise<null>(resolve => {
          stop = () => resolve(null);
          waiting.controller.signal.addEventListener("abort", stop, { once: true });
          if (waiting.controller.signal.aborted) stop();
        });
        try {
          while (current() && !waiting.controller.signal.aborted) {
            const checked = await Promise.race([reconcile(created, waiting.controller.signal), aborted]);
            if (!current() || !checked) return "stopped";
            if (checked.status === "success" && (checked.chainStatus === undefined || checked.chainStatus === "success")) return "success";
            if (checked.status !== "pending" || checked.chainStatus !== undefined && checked.chainStatus !== "pending") return "stopped";
            await abortableDelay(4_000, waiting.controller.signal);
          }
          return "stopped";
        } finally {
          window.clearTimeout(timeout);
          waiting.controller.signal.removeEventListener("abort", stop);
        }
      }
      void reconcile(created);
      return "stopped";
    } catch (caught) {
      if (mounted.current && lifecycle.current === submittedLifecycle && walletRef.current === submittedWallet) {
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
      if (recoveryWait.current?.signature === next?.signature) recoveryWait.current = null;
      submitting.current = false;
      if (!persisted && walletRef.current === submittedWallet && attemptSignatureRef.current === null) {
        attemptSignatureRef.current = attempt?.signature ?? null;
      }
      if (mounted.current && lifecycle.current === submittedLifecycle) setStage(null);
    }
    return "stopped";
  }


  async function scanWallet(restart = false) {
    if (!wallet || scanRunning.current || busy || submitting.current) return;
    const requestedWallet = wallet;
    const requestId = ++scanRequest.current;
    let cursor = restart ? null : scan.cursor;
    let scanned = restart ? 0 : scan.scanned;
    scanRunning.current = true;
    setScan(previous => ({ ...(restart ? emptyScan : previous), started: true, scanning: true, error: "" }));
    try {
      for (let page = 0; page < 20; page++) {
        const response = await post<DiscoveryPage>("/api/compound-recover-discover", { wallet: requestedWallet, ...(cursor ? { cursor } : {}) });
        if (!mounted.current || walletRef.current !== requestedWallet || requestId !== scanRequest.current) return;
        if (response.wallet !== requestedWallet || !Array.isArray(response.receipts) || response.receipts.some(item => item.wallet !== requestedWallet)) {
          throw new Error("Yield account query does not match connected wallet");
        }
        for (const receipt of response.receipts) persistCompoundReceipt(window.localStorage, receipt);
        setReceipts(loadCompoundReceipts(window.localStorage, requestedWallet).receipts);
        const incomplete = response.incomplete || response.errors > 0;
        scanned += response.scanned;
        const nextCursor = response.nextCursor;
        setScan({ started: true, scanning: !incomplete && !!nextCursor && page < 19, cursor: nextCursor,
          scanned, total: response.totalCandidates, incomplete,
          error: incomplete ? "Some accounts could not be verified. Retry the scan before treating it as complete." : "" });
        if (incomplete || !nextCursor) return;
        if (nextCursor === cursor) throw new Error("Account scan did not advance. Please retry.");
        cursor = nextCursor;
      }
    } catch (caught) {
      if (mounted.current && walletRef.current === requestedWallet && requestId === scanRequest.current) {
        setScan(previous => ({ ...previous, scanning: false, incomplete: true,
          error: caught instanceof Error ? caught.message : "Unable to scan yield accounts. Please retry." }));
      }
    } finally { scanRunning.current = false; }
  }

  async function runRecovery(items: CompoundReceipt[], compoundSignature?: string) {
    if (!wallet || cleanupRunning.current || submitting.current || externalBlockedRef.current || !connectionRef.current.connected) return;
    const requestedWallet = wallet;
    const requestedLifecycle = lifecycle.current;
    const current = () => mounted.current && lifecycle.current === requestedLifecycle && walletRef.current === requestedWallet;
    cleanupRunning.current = true; operationLifecycle.current = lifecycle.current;
    let completed = 0;
    setCleanup({ completed, total: items.length, running: true, message: "Approve each cleanup transaction in your wallet.", compoundSignature });
    try {
      for (const receipt of items) {
        if (!current() || externalBlockedRef.current) return;
        const outcome = await submit(receipt, true);
        if (!current()) return;
        if (outcome !== "success") {
          setCleanup({ completed, total: items.length, running: false, compoundSignature,
            message: "Cleanup paused. Remaining balances are saved below. Verify the last transaction, then retry cleanup." });
          return;
        }
        completed++;
        setCleanup({ completed, total: items.length, running: true, compoundSignature, message: "Balance merged and account rent recovered." });
      }
      if (current()) setCleanup({ completed, total: items.length, running: false, compoundSignature,
        message: "All selected yield accounts cleaned up. Balances were merged into your wallet and account rent returned." });
    } catch (caught) {
      if (current()) setCleanup({ completed, total: items.length, running: false, compoundSignature,
        message: caught instanceof Error ? caught.message : "Cleanup paused. Check the last transaction before retrying." });
    } finally {
      cleanupRunning.current = false;
      if (current()) setCleanup(previous => previous ? { ...previous, running: false } : previous);
    }
  }
  useLayoutEffect(() => { runRecoveryRef.current = runRecovery; });
  useEffect(() => {
    const approved = autoCleanup.current;
    if (!approved || approved.wallet !== wallet || approved.identity !== identity || approved.signature !== visibleAttempt?.signature ||
      visibleAttempt.kind !== "compound" || attemptStatus !== "success" || chainStatus !== null && chainStatus !== "success" || stage !== null || cleanupRunning.current) return;
    const receipt = receipts.find(item => item.sourceSignature === approved.signature);
    if (!receipt) return;
    // Keep the approval until the callback actually starts. A receipt refresh
    // may replace this effect and timer without revoking the user's action.
    const timer = window.setTimeout(() => {
      if (!mounted.current || identityRef.current !== approved.identity || autoCleanup.current !== approved ||
        cleanupRunning.current || submitting.current || externalBlockedRef.current || !connectionRef.current.connected) return;
      autoCleanup.current = null;
      void runRecoveryRef.current([receipt], approved.signature);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [wallet, identity, visibleAttempt, attemptStatus, chainStatus, stage, receipts, externalBlocked]);

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
      if (!mounted.current || walletRef.current !== requestedWallet || operationRequest.current !== requestedOperation) return;
      if (response.receipt.wallet !== requestedWallet || response.receipt.sourceSignature !== requestedSignature) {
        throw new Error("Yield account and query wallet or transaction signature mismatch");
      }
      persistCompoundReceipt(window.localStorage, response.receipt);
      setReceipts(loadCompoundReceipts(window.localStorage, requestedWallet).receipts);
    } catch (caught) {
      if (mounted.current && walletRef.current === requestedWallet && operationRequest.current === requestedOperation) setError(caught instanceof Error ? caught.message : "Yield account query failed", requestedIdentity);
    } finally { if (mounted.current && walletRef.current === requestedWallet) setImporting(false); }
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
    scan: loadedWallet === wallet ? scan : emptyScan, scanWallet, cleanup: loadedWallet === wallet ? cleanup : null, cleanupAll: () => runRecovery(receipts),
    canCleanup: !!wallet && connection.connected && loadedWallet === wallet && !busy && !externalBlocked && !storageInvalid &&
      (!visibleAttempt || resolvedAttempt.current?.signature === visibleAttempt.signature && recoveryMayProceed(resolvedAttempt.current)) && receipts.length > 0,
    ready: !!wallet && connection.connected && !walletBlocked && !externalBlocked,
    refreshState, compound: () => { void submit(); }, recover: (receipt: CompoundReceipt) => runRecovery([receipt]), retryReconcile,
    storageKey: wallet ? compoundAttemptKey(wallet) : null };
}

export type CompoundController = ReturnType<typeof useCompoundController>;
