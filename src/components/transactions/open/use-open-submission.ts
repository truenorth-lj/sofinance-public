"use client";
import "@/lib/engine-host";

import { useCallback, useRef, useState, type RefObject } from "react";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { OpenPositionQuote, OpenPositionSummary } from "@sofinance/engine/open-types";
import type { OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { addMintSignature, assertWalletReturnedTransaction, missingRequiredSignatures } from "@/lib/open-signatures";
import { jupiterRelayFailureMessage, postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { notSentRetryMessage } from "@/lib/public-error";
import { openAttemptFromSummary, type OpenAttempt } from "@/lib/open-attempt";
import { openBeamStatus, type OpenBeamStatus } from "@/lib/open-beam-status";
import { getStoredAttribution } from "@/lib/analytics/attribution";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { classifyOpenError } from "@/lib/analytics/errors";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";

type ApiError = { error: string };
type Prepared = { unsignedTransaction: string; permit: string; summary: OpenPositionSummary };

export type OpenSubmitStage = "preparing" | "wallet" | "broadcasting" | "pending" | "confirmed" | "failed" | "expired" | "manual-review" | null;

/** Hard cap so prepare cannot spin past a Jupiter 429 wait with no UI error. */
export const OPEN_PREPARE_TIMEOUT_MS = 45_000;

type OpenSubmissionOptions = {
  pair: { poolAddress: string; symbolA: string; symbolB: string } | null;
  wallet?: string;
  inputMint: string | null;
  inputKind: "native" | "token";
  amount: string;
  rangePreset: OpenRangePreset;
  minPrice: string;
  maxPrice: string;
  parsedAmount: bigint | null;
  quote: OpenPositionQuote | null;
  fresh: boolean;
  busy: boolean;
  identity: string;
  // Attempt owns durable write/readback, synchronous publication and unsent ownership.
  open: { loaded: boolean; track: (attempt: OpenAttempt) => void; markUnsent: (attempt: OpenAttempt) => void };
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  // Facade owns form/lifetime effects, shared discovery error, clock and per-modal relay store.
  activeRef: RefObject<boolean>;
  walletRef: RefObject<string | undefined>;
  identityRef: RefObject<string>;
  jupiterStoreRef: RefObject<JupiterRelayStore>;
  setError: (error: string) => void;
  setNow: (now: number) => void;
  setQuote: (quote: OpenPositionQuote | null) => void;
  setQuoteLoading: (loading: boolean) => void;
};

/** State only: bind the command after the facade derives busy/form/identity.
 * Neither phase registers effects, so attempt, analytics, lifetime and preview keep their order.
 */
export function useOpenSubmission() {
  const [operationStage, setSubmitStage] = useState<OpenSubmitStage>(null);
  // Metadata is keyed by the original signature; the facade shows it only after verification.
  const [beamResult, setBeamResult] = useState<{ signature: string; status: OpenBeamStatus } | null>(null);
  const submittingRef = useRef(false);
  return { operationStage, setSubmitStage, beamResult, setBeamResult, submittingRef };
}

/** Render-captured inputs preserve retained callback semantics; only identity/lifetime refs are live. */
export function useOpenSubmissionCommand({ pair, wallet, inputMint, inputKind, amount, rangePreset,
  minPrice, maxPrice, parsedAmount, quote, fresh, busy, identity, open, signTransaction,
  activeRef, walletRef, identityRef, jupiterStoreRef, setError, setNow, setQuote, setQuoteLoading,
}: OpenSubmissionOptions, { setSubmitStage, setBeamResult, submittingRef }: ReturnType<typeof useOpenSubmission>) {
  return useCallback(async () => {
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
  }, [amount, busy, fresh, identity, inputKind, inputMint, maxPrice, minPrice, open, pair, parsedAmount, quote, rangePreset, setQuote, setQuoteLoading, signTransaction, wallet, activeRef, identityRef, jupiterStoreRef, submittingRef, walletRef, setBeamResult, setError, setNow, setSubmitStage]);

}
