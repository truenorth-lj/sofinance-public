"use client";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";
import { compoundAttemptKey, signedCompoundTransaction, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CleanupBatchPrepared, CleanupBatchConfirmation } from "@/lib/compound-cleanup-batch-types";
import { ApiRequestError } from "@/lib/public-error";
import { batchUnresolved, cleanupBatchKey, cleanupBatchProgress, loadCleanupBatch, persistCleanupBatch, pruneCleanedReceipts,
  validBatchSummary, type CleanupBatchAttempt } from "@/lib/compound-cleanup-batch-attempt";
import type { WalletConnection } from "./wallet-connection";
import { captureWalletReturnedTxFailure } from "@/lib/sentry/capture";

type Options = { wallet?: string; identity: string; connection: WalletConnection; blocked: boolean;
  canStart: () => boolean; onReceipts: (receipts: CompoundReceipt[]) => void; onConfirmed: () => void };
async function post<T>(url: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
  const value = await response.json();
  if (!response.ok) throw new ApiRequestError(value.error || "Cleanup request failed", value.sent === false ? false : undefined);
  return value;
}
const tabChanged = "Cleanup paused because another tab changed the transaction record. Reload and verify the other tab's transaction before continuing.";
export function useCleanupBatchController(options: Options) {
  const latest = useRef(options); useLayoutEffect(() => { latest.current = options; });
  const [attempt, setAttempt] = useState<CleanupBatchAttempt | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [stage, setStage] = useState<"preparing" | "wallet" | "broadcasting" | null>(null);
  const [error, setError] = useState("");
  const running = useRef(false), checking = useRef(false), alive = useRef(true);
  const lastPoll = useRef({ signatures: "", at: 0 });
  const record = useRef<string | null>(null), generation = useRef(0);
  useLayoutEffect(() => { generation.current++; }, [options.wallet, options.identity, options.connection.connected, options.blocked]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const wallet = options.wallet;
    const timer = window.setTimeout(() => {
      if (!alive.current || latest.current.wallet !== wallet) return;
      setStage(null); setError("");
      if (!wallet) { setAttempt(null); setInvalid(false); setLoaded(null); record.current = null; return; }
      try {
        const saved = loadCleanupBatch(window.localStorage, wallet);
        record.current = window.localStorage.getItem(cleanupBatchKey(wallet));
        setAttempt(saved.attempt); setInvalid(saved.invalid); setLoaded(wallet);
        if (saved.attempt) latest.current.onReceipts(pruneCleanedReceipts(window.localStorage, saved.attempt));
        if (saved.invalid) setError("Local cleanup signatures need verification before starting another operation.");
      } catch { setInvalid(true); setLoaded(wallet); setError("Unable to read saved cleanup signatures."); }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [options.wallet]);
  useEffect(() => {
    const timer = window.setTimeout(() => setStage(null), 0);
    return () => window.clearTimeout(timer);
  }, [options.identity, options.wallet, options.connection.connected]);
  useEffect(() => {
    const wallet = options.wallet;
    if (!wallet) return;
    const changed = (event: StorageEvent) => {
      if (event.key !== null && event.key !== cleanupBatchKey(wallet)) return;
      if (window.localStorage.getItem(cleanupBatchKey(wallet)) !== record.current) {
        setInvalid(true); setError(tabChanged);
      }
    };
    window.addEventListener("storage", changed);
    return () => window.removeEventListener("storage", changed);
  }, [options.wallet]);
  const reconcile = useCallback(async (includeReview = false) => {
    const currentOptions = latest.current, wallet = currentOptions.wallet;
    if (!wallet || checking.current || running.current || !alive.current) return;
    checking.current = true;
    try {
      const snapshot = window.localStorage.getItem(cleanupBatchKey(wallet));
      if (snapshot !== record.current) { setError(tabChanged); setInvalid(true); return; }
      const saved = loadCleanupBatch(window.localStorage, wallet);
      if (saved.invalid || !saved.attempt) return;
      const pending = saved.attempt.transactions.filter(tx => !tx.unsent && (tx.status === "pending" || includeReview && tx.status === "manual-review"));
      if (!pending.length) return;
      const signatures = pending.map(tx => tx.signature).join(":");
      if (!includeReview && lastPoll.current.signatures === signatures && Date.now() - lastPoll.current.at < 4_000) return;
      lastPoll.current = { signatures, at: Date.now() };
      const results = await Promise.all(pending.map(async tx => {
        try {
          const result = await post<CleanupBatchConfirmation>("/api/compound-cleanup-confirm",
            { wallet, summary: tx.summary, signature: tx.signature });
          if (result.signature !== tx.signature || !["pending", "success", "failed", "expired", "manual-review"].includes(result.status) ||
            result.chainStatus !== undefined && !["pending", "success", "failed", "expired", "unknown"].includes(result.chainStatus) ||
            result.status === "success" && result.chainStatus !== "success") throw new Error("Cleanup verification mismatch");
          return { ...tx, status: result.status, chainStatus: result.chainStatus };
        } catch { return tx; } // A transport timeout is uncertainty. Keep the exact signature and poll again.
      }));
      if (!alive.current || latest.current.wallet !== wallet) return;
      if (window.localStorage.getItem(cleanupBatchKey(wallet)) !== snapshot) { setError(tabChanged); setInvalid(true); return; }
      const next = { ...saved.attempt, transactions: saved.attempt.transactions.map(tx => results.find(result => result.signature === tx.signature) || tx) };
      if (JSON.stringify(next) === snapshot) return;
      record.current = persistCleanupBatch(window.localStorage, next); setAttempt(next);
      latest.current.onReceipts(pruneCleanedReceipts(window.localStorage, next));
      const newSuccess = next.transactions.some(tx => tx.status === "success" && saved.attempt!.transactions.find(old => old.signature === tx.signature)?.status !== "success");
      if (newSuccess) { setError(""); latest.current.onConfirmed(); }
      if (!batchUnresolved(next)) setError("");
    } catch (caught) { if (alive.current && latest.current.wallet === wallet) setError(caught instanceof Error ? caught.message : "Cleanup verification will retry"); }
    finally { checking.current = false; }
  }, []);
  const pendingSignatures = attempt?.transactions.filter(tx => tx.status === "pending" && !tx.unsent).map(tx => tx.signature).join(":") || "";
  useEffect(() => {
    if (!options.wallet || loaded !== options.wallet || !pendingSignatures || invalid) return;
    const run = () => { void reconcile(); };
    const initial = window.setTimeout(run, 0), timer = window.setInterval(run, 4_000);
    window.addEventListener("focus", run); document.addEventListener("visibilitychange", run);
    return () => { window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("focus", run); document.removeEventListener("visibilitychange", run); };
  }, [options.wallet, loaded, pendingSignatures, invalid, reconcile]);

  async function start(receipts: CompoundReceipt[]) {
    const initial = latest.current, wallet = initial.wallet;
    if (!wallet || loaded !== wallet || invalid || running.current || checking.current || batchUnresolved(attempt) || !receipts.length ||
      !initial.connection.connected || initial.connection.address !== wallet || initial.blocked || !initial.canStart()) return;
    const selectedGeneration = generation.current;
    const compoundRecord = window.localStorage.getItem(compoundAttemptKey(wallet));
    let batchRecord = window.localStorage.getItem(cleanupBatchKey(wallet));
    const current = () => alive.current && generation.current === selectedGeneration && latest.current.wallet === wallet &&
      latest.current.identity === initial.identity && latest.current.connection.connected && latest.current.connection.address === wallet && !latest.current.blocked;
    const fence = () => {
      if (!current()) throw new Error("Wallet, position, or authorization changed; cleanup stopped");
      if (window.localStorage.getItem(compoundAttemptKey(wallet)) !== compoundRecord ||
        window.localStorage.getItem(cleanupBatchKey(wallet)) !== batchRecord) throw new Error(tabChanged);
    };
    running.current = true; setError(""); setStage("preparing");
    let durable: CleanupBatchAttempt | null = null;
    try {
      fence();
      if (batchRecord !== record.current) throw new Error(tabChanged);
      const accounts = receipts.flatMap(receipt => receipt.compoundAccounts);
      if (receipts.some(receipt => receipt.wallet !== wallet) || new Set(accounts.map(account => account.address)).size !== accounts.length) throw new Error("Cleanup sources do not match wallet");
      const prepared = await post<CleanupBatchPrepared>(
        "/api/compound-cleanup-prepare", { wallet, compoundAccounts: accounts }, 120_000);
      fence();
      if (prepared.wallet !== wallet || !Array.isArray(prepared.alreadyClosed) || !Array.isArray(prepared.transactions) || prepared.transactions.length > 32) throw new Error("Cleanup preparation mismatch");
      const expected = new Set(accounts.map(account => account.address));
      const seen = new Set<string>();
      for (const address of prepared.alreadyClosed) { if (!expected.has(address) || seen.has(address)) throw new Error("Closed source mismatch"); seen.add(address); }
      const unsigned = prepared.transactions.map(item => {
        if (!item.permit || !validBatchSummary(item.summary, wallet, receipts[0]!.positionMint, receipts[0]!.sourceSignature) ||
          Date.now() >= item.summary.expiresAt) throw new Error("Cleanup simulation is invalid or expired");
        for (const account of item.summary.compoundAccounts) {
          const original = accounts.find(source => source.address === account.address);
          if (!original || seen.has(account.address) || ["seed", "mint", "program", "space"].some(key => original[key as keyof typeof original] !== account[key as keyof typeof account])) throw new Error("Cleanup sources mismatch");
          seen.add(account.address);
        }
        const tx = VersionedTransaction.deserialize(Uint8Array.from(atob(item.unsignedTransaction), ch => ch.charCodeAt(0)));
        if (tx.serialize().length > 1232 || tx.message.header.numRequiredSignatures !== 1 || tx.message.staticAccountKeys[0]?.toBase58() !== wallet ||
          tx.message.recentBlockhash !== item.summary.blockhash) throw new Error("Cleanup transaction payer, size, or blockhash mismatch");
        return { tx, preparedSnapshot: VersionedTransaction.deserialize(tx.serialize()) };
      });
      if (seen.size !== expected.size) throw new Error("Cleanup preparation omitted selected accounts");
      if (unsigned.length > 1 && !latest.current.connection.signAllTransactions) throw new Error("This wallet does not support one-approval batch signing. Use a wallet with signAllTransactions support to clean all balances together.");
      let signed: VersionedTransaction[] = [];
      if (unsigned.length) {
        setStage("wallet"); fence();
        signed = unsigned.length === 1
          ? [await latest.current.connection.signTransaction(unsigned[0]!.tx)]
          : await latest.current.connection.signAllTransactions!(unsigned.map((item) => item.tx));
        fence();
      }
      if (!Array.isArray(signed) || signed.length !== unsigned.length) throw new Error("Wallet returned incomplete cleanup signatures");
      const signedResults = signed.map((tx, index) => {
        let result: ReturnType<typeof signedCompoundTransaction>;
        try {
          result = signedCompoundTransaction(tx, unsigned[index]!.preparedSnapshot, wallet);
        } catch (error) {
          captureWalletReturnedTxFailure(error);
          throw error;
        }
        if (!nacl.sign.detached.verify(tx.message.serialize(), tx.signatures[0]!, tx.message.staticAccountKeys[0]!.toBytes())) throw new Error("Wallet returned an invalid cleanup signature");
        if (tx.serialize().length > 1232 || Date.now() >= prepared.transactions[index]!.summary.expiresAt) throw new Error("Signed cleanup transaction expired or is oversized");
        return result;
      });
      fence();
      durable = { version: 1, wallet, createdAt: Date.now(), receipts, alreadyClosed: prepared.alreadyClosed,
        transactions: signedResults.map((result, index) => ({ signature: result.signature, summary: prepared.transactions[index]!.summary, status: "pending" })) };
      batchRecord = persistCleanupBatch(window.localStorage, durable); record.current = batchRecord; setAttempt(durable);
      latest.current.onReceipts(pruneCleanedReceipts(window.localStorage, durable));
      setStage("broadcasting");
      // Broadcast all signed chunks while their shared validity window remains fresh. Confirmation is independent and restartable.
      const outcomes = await Promise.allSettled(signedResults.map((result, index) => {
        fence();
        const item = prepared.transactions[index]!;
        return post<{ signature: string }>("/api/compound-cleanup-broadcast", { wallet, summary: item.summary,
          permit: item.permit, unsignedTransaction: item.unsignedTransaction, signedTransaction: result.signedTransaction }, 60_000).then(response => {
          if (response.signature !== result.signature) throw new Error("Cleanup broadcast signature mismatch; checking original signature");
          return response;
        });
      }));
      fence();
      // Every request began inside the validity window. Save known rejections in one fenced update.
      // Unknown transport outcomes retain their signatures; never ask the wallet to sign again.
      if (outcomes.some(outcome => outcome.status === "rejected" && outcome.reason instanceof ApiRequestError && outcome.reason.sent === false)) {
        durable = { ...durable, transactions: durable.transactions.map((tx, index) => {
          const outcome = outcomes[index]!;
          return outcome.status === "rejected" && outcome.reason instanceof ApiRequestError && outcome.reason.sent === false
            ? { ...tx, unsent: true, status: "failed" } : tx;
        }) };
        batchRecord = persistCleanupBatch(window.localStorage, durable); record.current = batchRecord; setAttempt(durable);
      }
    } catch (caught) {
      if (alive.current && latest.current.wallet === wallet) setError(caught instanceof Error ? caught.message : "Cleanup stopped; signed transactions will be checked");
    } finally {
      running.current = false;
      if (alive.current && latest.current.wallet === wallet) { setStage(null); void reconcile(); }
    }
  }
  const visible = loaded === options.wallet ? attempt : null;
  const progress = visible ? cleanupBatchProgress(visible) : null;
  const unresolved = batchUnresolved(visible);
  const needsReview = visible?.transactions.some(tx => tx.status === "manual-review");
  return { start, reconcile: () => reconcile(true), attempt: visible, invalid, loaded: loaded === options.wallet, stage, busy: stage !== null, unresolved, error,
    progress: progress && { ...progress, compoundSignature: undefined as string | undefined, running: stage !== null || unresolved, message: stage === "wallet" ? "Approve the cleanup batch once in your wallet."
      : stage === "preparing" ? "Preparing and simulating all selected accounts…" : stage === "broadcasting" ? "Sending signed cleanup transactions…"
      : needsReview ? "Some cleanup results need verification. Use Requery cleanup results before continuing."
      : unresolved ? "Checking signed cleanup transactions. Temporary connection errors retry automatically; no further signature is needed."
      : progress.completed === progress.total ? "All selected yield accounts cleaned up. Balances and account rent returned to your wallet."
      : "Some cleanup transactions did not complete. Scan again to retry only the remaining accounts." } };
}
