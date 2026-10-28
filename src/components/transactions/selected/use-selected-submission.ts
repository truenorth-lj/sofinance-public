"use client";
import "@/lib/engine-host";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { PositionSelection, SelectedPositionState } from "@sofinance/engine/selected-state";
import { persistSelectedAttempt, type SelectedAttempt } from "@/lib/selected-attempt";
import type { SelectedQuote } from "@/lib/selected-quote";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { RELAY_DEADLINE_MS, selectionKey, type Preflight } from "./selected-preview-model";

type Prepared = Preflight & { unsignedTransaction: string; blockhash: string;
  lastValidBlockHeight: number; startingLiquidity: string;
  startingBalances: SelectedPositionState["balances"]; expiresAt: number; permit: string };
type ApiError = { error: string };

type SelectedSubmissionOptions = {
  // Render-captured values, not latest-value refs: a retained callback keeps its inputs.
  ready: boolean | null;
  quoteLoading: boolean;
  quote: SelectedQuote | null;
  fresh: boolean;
  wallet?: string;
  selection: PositionSelection | null;
  visibleState: SelectedPositionState | null;
  amount: string;
  rawAmount: bigint;
  floorBps: number;
  toleranceBps: number | null;
  attempt: SelectedAttempt | null;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  // Only these identity/cache reads are live, at the original await boundaries.
  isWalletCurrent: (wallet: string) => boolean;
  getSelectionKey: () => string;
  getInputRevision: () => number;
  getRelayStore: () => JupiterRelayStore;
  // Attempt owns query identity and publication; submission owns durable write/send.
  beginSubmission: () => void;
  restoreSignature: (signature: string | null) => void;
  publishPersisted: (current: SelectedAttempt) => void;
  reconcileAttempt: (current: SelectedAttempt) => Promise<void>;
  adoptPreview: (prepared: Preflight) => void;
  clearPreview: () => void;
  setNow: (now: number) => void;
  refreshState: () => Promise<void>;
};

/**
 * Selected command/lifetime owner. Call before attempt setup so its restoration
 * layout effect sees the new lifetime. submit accepts a render snapshot at the
 * facade command boundary; no mutable facade refs or reverse imports are needed.
 */
export function useSelectedSubmission() {
  const [error, setError] = useState("");
  const [submitStage, setSubmitStage] = useState<"preparing" | "wallet" | "broadcasting" | null>(null);
  const busy = submitStage !== null;
  const submittingRef = useRef(false);
  const lifetimeRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    // A fresh token on every setup prevents effect replay from reviving old work.
    lifetimeRef.current = {};
    return () => { lifetimeRef.current = null; };
  }, []);
  const getLifetime = useCallback(() => lifetimeRef.current, []);
  const isSubmitting = useCallback(() => submittingRef.current, []);
  const clearError = useCallback(() => setError(""), []);

  async function submit({ ready, quoteLoading, quote, fresh, wallet, selection, visibleState, amount, rawAmount, floorBps, toleranceBps,
    attempt, signTransaction, isWalletCurrent, getSelectionKey, getInputRevision, getRelayStore,
    beginSubmission, restoreSignature, publishPersisted, reconcileAttempt, adoptPreview, clearPreview, setNow, refreshState }: SelectedSubmissionOptions) {
    const lifetime = lifetimeRef.current;
    if (!lifetime) return;
    const ownsLifetime = () => lifetimeRef.current === lifetime;
    if (!ready || busy || submittingRef.current || quoteLoading || !quote || !fresh ||
      !wallet || !selection || !visibleState || toleranceBps === null) return;
    submittingRef.current = true;
    beginSubmission();
    const key = selectionKey(selection);
    const inputRevision = getInputRevision();
    setSubmitStage("preparing"); setError("");
    const aborter = new AbortController();
    const deadline = window.setTimeout(() => aborter.abort(new Error("Preparation took too long. Please retry.")), RELAY_DEADLINE_MS);
    try {
      const response = await postWithJupiterRelay("/api/selected-prepare", { wallet, ...selection, amount, floorBps, toleranceBps },
        { store: getRelayStore(), signal: aborter.signal });
      const data = await response.json() as Prepared | ApiError;
      window.clearTimeout(deadline);
      if (!ownsLifetime()) return;
      if (aborter.signal.aborted) throw aborter.signal.reason;
      if (!response.ok) throw new Error((data as ApiError).error);
      const prepared = data as Prepared;
      if (!isWalletCurrent(wallet) || getSelectionKey() !== key || getInputRevision() !== inputRevision ||
        !prepared.simulated || !prepared.permit || !prepared.startingBalances ||
        prepared.quote.wallet !== wallet ||
        selectionKey(prepared.quote) !== key || prepared.quote.requested !== rawAmount.toString() ||
        prepared.quote.floorBps !== floorBps || prepared.quote.toleranceBps !== toleranceBps || Date.now() >= prepared.expiresAt) {
        throw new Error("Requote or transaction authorization and current selection mismatch");
      }
      const bytes = Uint8Array.from(atob(prepared.unsignedTransaction), (character) => character.charCodeAt(0));
      const unsigned = VersionedTransaction.deserialize(bytes);
      const preparedSnapshot = VersionedTransaction.deserialize(unsigned.serialize());
      if (unsigned.message.recentBlockhash !== prepared.blockhash ||
        unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet) throw new Error("Transaction payer or blockhash mismatch");
      adoptPreview(prepared); setNow(Date.now());
      setSubmitStage("wallet");
      const signed = await signTransaction(unsigned);
      if (!ownsLifetime()) return;
      assertWalletReturnedTransaction(preparedSnapshot, signed, wallet);
      const signatureBytes = signed.signatures[0];
      if (!signatureBytes || signatureBytes.every((byte) => byte === 0)) throw new Error("Wallet did not return valid signature");
      if (!isWalletCurrent(wallet) || getSelectionKey() !== key || getInputRevision() !== inputRevision ||
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
        body: JSON.stringify({ wallet, selection, signedTransaction, unsignedTransaction: prepared.unsignedTransaction, permit: prepared.permit,
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
      if (ownsLifetime() && isWalletCurrent(wallet)) setError(caught instanceof Error ? caught.message : "Transaction not confirmed; check on-chain status before proceeding");
    }
    finally {
      window.clearTimeout(deadline); submittingRef.current = false;
      if (ownsLifetime() && isWalletCurrent(wallet)) restoreSignature(attempt?.signature ?? null);
      // Keep the synchronous lock until this run settles, including effect replay.
      // Clear retained state even while effects are disconnected; no newer run
      // can own the stage yet. React ignores this after a true unmount.
      setSubmitStage(null);
    }
  }

  return { error, submitStage, busy, clearError, getLifetime, isSubmitting, submit };
}
