"use client";
import "@/lib/engine-host";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import { createEphemeralMint, type EphemeralMint } from "@/lib/ephemeral-mint";
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
import { formatAmount } from "@sofinance/engine/amount";
import { rawToDecimalString, runSolSwapStep, SolSwapStepError, type SolSwapReceipt, type SolSwapStage } from "./sol-swap-step-client";

type ApiError = { error: string };
type Prepared = { unsignedTransaction: string; permit: string; summary: OpenPositionSummary };

export type OpenSubmitStage = SolSwapStage | "preparing" | "wallet" | "broadcasting" | "pending" | "confirmed" | "failed" | "expired" | "manual-review" | null;

/** Two-transaction SOL deposit: 1 = SOL -> pool token swap, 2 = token-input open. */
export type OpenStep = 1 | 2 | null;

export function solSwapReceiptLabel(receipt: SolSwapReceipt, fallbackSymbol?: string) {
  return `${formatAmount(receipt.delivered, receipt.decimals, receipt.decimals)} ${receipt.outputSymbol ?? fallbackSymbol ?? "pool tokens"}`;
}

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
  identity: object;
  // Attempt owns durable write/readback, synchronous publication and unsent ownership.
  open: { attempt: Pick<OpenAttempt, "signature"> | null; loaded: boolean; canSubmit: () => boolean; track: (attempt: OpenAttempt) => void; markUnsent: (attempt: OpenAttempt) => void };
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  // Facade owns form/lifetime effects, shared discovery error, clock and per-modal relay store.
  activeRef: RefObject<boolean>;
  walletRef: RefObject<string | undefined>;
  identityRef: RefObject<object>;
  lifetimeRef: RefObject<number>;
  jupiterStoreRef: RefObject<JupiterRelayStore>;
  setError: (error: string) => void;
  setNow: (now: number) => void;
  setQuote: (quote: OpenPositionQuote | null) => void;
  setQuoteLoading: (loading: boolean) => void;
};

/** State only: bind the command after the facade derives busy/form/identity.
 * The command phase publishes only committed quote readiness; it never owns preview loading effects.
 */
export function useOpenSubmission() {
  const [operationStage, setSubmitStage] = useState<OpenSubmitStage>(null);
  // Only a pre-submission retry failure may override its original terminal receipt.
  const [retryError, setRetryError] = useState<{ signature: string; message: string } | null>(null);
  // Metadata is keyed by the original signature; the facade shows it only after verification.
  const [beamResult, setBeamResult] = useState<{ signature: string; status: OpenBeamStatus } | null>(null);
  const [openStep, setOpenStep] = useState<OpenStep>(null);
  // A landed step 1/2 whose step 2/2 open has not confirmed yet ("retry open" resumes from it).
  const [swapReceipt, setSwapReceiptState] = useState<SolSwapReceipt | null>(null);
  const swapReceiptRef = useRef<SolSwapReceipt | null>(null);
  const setSwapReceipt = useCallback((receipt: SolSwapReceipt | null) => {
    swapReceiptRef.current = receipt;
    setSwapReceiptState(receipt);
  }, []);
  const submittingRef = useRef<object | null>(null);
  const inputRevisionRef = useRef(0);
  const [inputRevision, setInputRevision] = useState(0);
  const invalidateSubmission = useCallback(() => {
    // Revoke before React renders, including same-value and batched ABA commands.
    setRetryError(null);
    inputRevisionRef.current += 1;
    setInputRevision(inputRevisionRef.current);
  }, []);
  return { operationStage, setSubmitStage, retryError, setRetryError, beamResult, setBeamResult, submittingRef,
    inputRevision, inputRevisionRef, invalidateSubmission, openStep, setOpenStep, swapReceipt, swapReceiptRef, setSwapReceipt };
}

/** Input revisions revoke captured quotes; committed generations revoke saved commands and in-flight work. */
export function useOpenSubmissionCommand({ pair, wallet, inputMint, inputKind, amount, rangePreset,
  minPrice, maxPrice, parsedAmount, quote, fresh, busy, identity, open, signTransaction,
  activeRef, walletRef, identityRef, lifetimeRef, jupiterStoreRef, setError, setNow, setQuote, setQuoteLoading,
}: OpenSubmissionOptions, { setSubmitStage, setRetryError, setBeamResult, submittingRef, inputRevision, inputRevisionRef,
  setOpenStep, swapReceiptRef, setSwapReceipt }: ReturnType<typeof useOpenSubmission>) {
  const committedQuoteRef = useRef<OpenPositionQuote | null>(null);
  useLayoutEffect(() => { committedQuoteRef.current = quote; }, [quote]);
  const [generation, setGeneration] = useState<object | null>(null);
  const committedGenerationRef = useRef<object | null>(null);
  useLayoutEffect(() => {
    const nextGeneration = {};
    committedGenerationRef.current = nextGeneration;
    // Publish a new callback after reconnect, even when React retained the render.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Layout reconnect is the invalidation event; one commit publishes its new command generation before paint.
    setGeneration(nextGeneration);
    return () => { committedGenerationRef.current = null; };
  }, []);
  return useCallback(async () => {
    // Retry open (2/2): a landed step-1 swap for this wallet and pool resumes at the token-input open.
    const resume = swapReceiptRef.current && swapReceiptRef.current.wallet === wallet &&
      swapReceiptRef.current.poolId === pair?.poolAddress ? swapReceiptRef.current : null;
    if (!pair || !wallet || busy || !open.loaded || submittingRef.current) return;
    if (!resume && (!inputMint || !quote || !fresh || Date.now() >= quote.expiresAt)) return;
    const ownsInput = () => generation !== null && committedGenerationRef.current === generation &&
      activeRef.current && walletRef.current === wallet &&
      identityRef.current === identity && inputRevisionRef.current === inputRevision;
    if (!ownsInput() || (!resume && committedQuoteRef.current !== quote)) return;
    if (!open.canSubmit()) {
      const message = "Open-position history changed. Reload and verify the original signature before opening again.";
      setError(message);
      setRetryError(open.attempt ? { signature: open.attempt.signature, message } : null);
      return;
    }
    const owner = {};
    submittingRef.current = owner;
    const lifetime = lifetimeRef.current;
    const current = () => ownsInput() && lifetimeRef.current === lifetime && submittingRef.current === owner;
    let persisted: OpenAttempt | null = null;
    setQuoteLoading(false);
    setSubmitStage("preparing");
    setError("");
    setRetryError(null);
    captureGrowthEvent(GROWTH_EVENTS.openStarted, openEventProperties(pair));
    let mint: EphemeralMint | undefined;
    let receipt: SolSwapReceipt | null = resume;
    try {
      if (!receipt && inputKind === "native") {
        // Step 1/2: SOL -> pool token swap (10 bps inside the Jupiter swap). Phantom
        // blocks a single wrap + swap + open transaction, but passes these two.
        setOpenStep(1);
        receipt = await runSolSwapStep({
          wallet, poolId: pair.poolAddress, amount, requested: parsedAmount?.toString() ?? "",
          store: jupiterStoreRef.current, timeoutMs: OPEN_PREPARE_TIMEOUT_MS, signTransaction,
          setStage: setSubmitStage, current,
        });
        setSwapReceipt(receipt);
        if (!current()) throw new Error("Wallet or input changed after step 1/2");
        setSubmitStage("preparing");
      }
      if (receipt) setOpenStep(2);
      // Step 2/2 deposits exactly what step 1 delivered (confirmed tx meta), never the quote.
      const openInputMint = receipt ? receipt.outputMint : inputMint!;
      const openInputKind: "native" | "token" = receipt ? "token" : inputKind;
      const openAmount = receipt ? rawToDecimalString(receipt.delivered, receipt.decimals) : amount;
      const openRequested = receipt ? receipt.delivered : parsedAmount?.toString();
      mint = createEphemeralMint();
      // Same per-modal store as the preview: prepare replays the preview's fresh
      // Jupiter quotes and only fetches swap-instructions.
      const response = await postWithJupiterRelay("/api/open-prepare", {
        wallet, poolId: pair.poolAddress, inputMint: openInputMint, inputKind: openInputKind, amount: openAmount,
        rangePreset, minPrice, maxPrice, nftMint: mint.publicKey.toBase58(),
        ...(receipt ? { solSwapSignature: receipt.signature } : {}),
      }, { store: jupiterStoreRef.current, signal: AbortSignal.timeout(OPEN_PREPARE_TIMEOUT_MS) });
      const data = await response.json() as Prepared | ApiError;
      if (!response.ok) throw new Error((data as ApiError).error);
      const prepared = data as Prepared;
      if (!current() || !prepared.unsignedTransaction || !prepared.permit || !prepared.summary ||
        prepared.summary.wallet !== wallet || prepared.summary.poolId !== pair.poolAddress ||
        prepared.summary.nftMint !== mint.publicKey.toBase58() ||
        prepared.summary.quote.requested !== openRequested ||
        prepared.summary.quote.inputMint !== openInputMint || prepared.summary.quote.inputKind !== openInputKind ||
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
      if (!open.canSubmit()) throw new Error("Open-position history changed. Reload and verify the original signature before opening again.");
      setQuote(prepared.summary.quote);
      setNow(Date.now());
      setSubmitStage("wallet");
      const signedByWallet = await signTransaction(unsigned);
      assertWalletReturnedTransaction(preparedSnapshot, signedByWallet, wallet);
      let signed: VersionedTransaction;
      try {
        signed = addMintSignature(signedByWallet, mint);
      } finally {
        mint.dispose();
      }
      if (missingRequiredSignatures(signed).length) {
        throw new Error("Open-position transaction is missing required signatures");
      }
      const signatureBytes = signed.signatures[0]!;
      const txSignature = bs58.encode(signatureBytes);
      const signedTransaction = btoa(String.fromCharCode(...signed.serialize()));
      if (!current() || Date.now() >= prepared.summary.expiresAt) throw new Error("Wallet, input or quote changed during signing; transaction not sent");
      if (!open.canSubmit()) throw new Error("Open-position history changed. Reload and verify the original signature before opening again.");
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
      if (walletRef.current === wallet) {
        const reason = jupiterRelayFailureMessage(caught, "Preparing the transaction timed out. Please retry.");
        const message = persisted
          ? "Submission result is unconfirmed. Tracking the original signature; do not open again until it is verified."
          : receipt
            ? `Step 1/2 done: ${solSwapReceiptLabel(receipt)} are in your wallet. Step 2/2 (open position) failed: ${reason} Use "Retry open" to try step 2/2 again.`
            : caught instanceof SolSwapStepError && caught.signature
              ? `${reason} (swap ${caught.signature.slice(0, 8)}…)`
              : reason;
        setError(message);
        // A later chain result must supersede an unknown send, even when retrying a failed attempt.
        if (current()) setRetryError(!persisted && open.attempt
          ? { signature: open.attempt.signature, message } : null);
      }
    } finally {
      mint?.dispose();
      // A canceled operation keeps its lock until settlement; release only its own owner.
      if (submittingRef.current === owner) {
        submittingRef.current = null;
        setSubmitStage(null);
        setOpenStep(null);
      }
    }
  }, [amount, busy, fresh, generation, identity, inputRevision, inputRevisionRef, inputKind, inputMint, maxPrice, minPrice, open, pair, parsedAmount, quote, rangePreset, setQuote, setQuoteLoading, signTransaction, wallet, activeRef, identityRef, lifetimeRef, jupiterStoreRef, submittingRef, walletRef, setBeamResult, setError, setNow, setRetryError, setSubmitStage,
    setOpenStep, setSwapReceipt, swapReceiptRef]);

}
