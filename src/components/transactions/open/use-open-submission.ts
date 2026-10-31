"use client";
import "@/lib/engine-host";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { OpenPositionQuote } from "@sofinance/engine/open-types";
import type { OpenRangePreset } from "@sofinance/engine/open-range-presets";
import { jupiterRelayFailureMessage, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { plainTxError, reportTxFailure, runTx, TxLandedUnknownError, TxNotSentError, TxRunError, TxSendUnknownError, type TxWallet } from "@/lib/tx-pipeline";
import { OPEN_PREPARE_TIMEOUT_MS, openPositionAdapter } from "../adapters/open";
import { openAttemptFromSummary, type OpenAttempt } from "@/lib/open-attempt";
import { captureGrowthEvent } from "@/lib/analytics/client";
import { openFailureProperties } from "@/lib/analytics/errors";
import { GROWTH_EVENTS, openEventProperties } from "@/lib/analytics/events";
import { readSolSwapAttempt, requireSolSwapStorage } from "./sol-swap-attempt-store";
import { formatAmount } from "@sofinance/engine/amount";
import { rawToDecimalString, runSolSwapStep, SolSwapStepError, type SolSwapReceipt, type SolSwapStage } from "./sol-swap-step-client";
import { clearSolSwapReceipt, isSolSwapReceiptExpired, receiptStorage, saveSolSwapReceipt,
  type PendingSolSwapReceipt } from "./sol-swap-receipt-store";

export type OpenSubmitStage = SolSwapStage | "preparing" | "wallet" | "checking" | "broadcasting" | "pending" | "confirmed" | "failed" | "expired" | "manual-review" | null;

/** Two-transaction SOL deposit: 1 = SOL -> pool token swap, 2 = token-input open. */
export type OpenStep = 1 | 2 | null;

export function solSwapReceiptLabel(receipt: SolSwapReceipt, fallbackSymbol?: string) {
  return `${formatAmount(receipt.delivered, receipt.decimals, receipt.decimals)} ${receipt.outputSymbol ?? fallbackSymbol ?? "pool tokens"}`;
}

export { OPEN_PREPARE_TIMEOUT_MS };

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
  open: { attempt: Pick<OpenAttempt, "signature"> | null; loaded: boolean; canSubmit: () => boolean; track: (attempt: OpenAttempt) => void };
  txWallet: TxWallet;
  /** One-tap retry after a failure that left nothing on-chain. */
  retry: () => void;
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
  const [openStep, setOpenStep] = useState<OpenStep>(null);
  // Set after a failure that left nothing on-chain: the modal offers one-tap "Try again".
  const [reprepare, setReprepare] = useState(false);
  // A landed step 1/2 whose step 2/2 open has not confirmed yet ("Continue open (2/2)" resumes from it).
  // Persisted per wallet + pool so form edits, closing the modal or a reload cannot strand the swapped tokens.
  const [swapReceipt, setSwapReceiptState] = useState<PendingSolSwapReceipt | null>(null);
  const swapReceiptRef = useRef<PendingSolSwapReceipt | null>(null);
  /** `persist: false` only mirrors storage into memory (hydration); null then leaves storage untouched. */
  const setSwapReceipt = useCallback((receipt: PendingSolSwapReceipt | null, options: { persist?: boolean } = {}) => {
    const previous = swapReceiptRef.current;
    swapReceiptRef.current = receipt;
    setSwapReceiptState(receipt);
    if (options.persist === false) return;
    const storage = receiptStorage();
    if (!storage) return;
    if (receipt) saveSolSwapReceipt(storage, receipt);
    else if (previous) clearSolSwapReceipt(storage, previous.wallet, previous.poolId);
  }, []);
  const submittingRef = useRef<object | null>(null);
  const inputRevisionRef = useRef(0);
  const [inputRevision, setInputRevision] = useState(0);
  const invalidateSubmission = useCallback(() => {
    // Revoke before React renders, including same-value and batched ABA commands.
    setRetryError(null);
    setReprepare(false);
    inputRevisionRef.current += 1;
    setInputRevision(inputRevisionRef.current);
  }, []);
  return { operationStage, setSubmitStage, retryError, setRetryError, submittingRef, reprepare, setReprepare,
    inputRevision, inputRevisionRef, invalidateSubmission, openStep, setOpenStep, swapReceipt, swapReceiptRef, setSwapReceipt };
}

/** Input revisions revoke captured quotes; committed generations revoke saved commands and in-flight work. */
export function useOpenSubmissionCommand({ pair, wallet, inputMint, inputKind, amount, rangePreset,
  minPrice, maxPrice, parsedAmount, quote, fresh, busy, identity, open, txWallet, retry,
  activeRef, walletRef, identityRef, lifetimeRef, jupiterStoreRef, setError, setNow, setQuote, setQuoteLoading,
}: OpenSubmissionOptions, { setSubmitStage, setRetryError, submittingRef, inputRevision, inputRevisionRef,
  setOpenStep, swapReceiptRef, setSwapReceipt, setReprepare }: ReturnType<typeof useOpenSubmission>) {
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
    // Continue open (2/2): a landed step-1 swap for this wallet and pool resumes at the token-input open.
    const resume = swapReceiptRef.current && swapReceiptRef.current.wallet === wallet &&
      swapReceiptRef.current.poolId === pair?.poolAddress && !isSolSwapReceiptExpired(swapReceiptRef.current, Date.now())
      ? swapReceiptRef.current : null;
    if (!pair || !wallet || busy || !open.loaded || submittingRef.current) return;
    if (!resume && (!inputMint || !quote || !fresh)) return;
    const ownsInput = () => generation !== null && committedGenerationRef.current === generation &&
      activeRef.current && walletRef.current === wallet &&
      identityRef.current === identity && inputRevisionRef.current === inputRevision;
    if (!ownsInput() || (!resume && committedQuoteRef.current !== quote)) return;
    try {
      if (readSolSwapAttempt(requireSolSwapStorage(), wallet)) {
        setError("Check the original SOL swap before opening again.");
        return;
      }
    } catch (error) { setError(error instanceof Error ? error.message : "Unable to read SOL swap history"); return; }
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
    let sent = false;
    setQuoteLoading(false);
    setSubmitStage("preparing");
    setError("");
    setRetryError(null);
    setReprepare(false);
    captureGrowthEvent(GROWTH_EVENTS.openStarted, openEventProperties(pair, { wallet, inputKind }));
    let receipt: PendingSolSwapReceipt | null = resume;
    // Two-step SOL open: the step a failure belongs to (reported as open_step on open_position_failed).
    let failedStep: 1 | 2 | null = resume ? 2 : null;
    try {
      if (!receipt && inputKind === "native") {
        // Step 1/2: SOL -> pool token swap (10 bps inside the Jupiter swap). Phantom
        // blocks a single wrap + swap + open transaction, but passes these two.
        setOpenStep(1);
        failedStep = 1;
        const landed = await runSolSwapStep({
          wallet: txWallet, poolId: pair.poolAddress, amount, requested: parsedAmount?.toString() ?? "",
          store: jupiterStoreRef.current, timeoutMs: OPEN_PREPARE_TIMEOUT_MS,
          setStage: setSubmitStage, current,
        });
        receipt = landed;
        failedStep = 2;
        setSwapReceipt(receipt, { persist: false });
        if (!current()) throw new TxNotSentError("Your wallet or inputs changed after step 1/2. Nothing else was sent.");
      }
      if (receipt) {
        setOpenStep(2);
        failedStep = 2;
      }
      // Step 2/2 deposits exactly what step 1 delivered (confirmed tx meta), never the quote.
      const blockedBeforeWallet = () => {
        if (readSolSwapAttempt(requireSolSwapStorage(), wallet)) throw new TxNotSentError("Check the original SOL swap before opening again.");
        if (!open.canSubmit()) throw new TxNotSentError("Another open-position transaction is still confirming. Wait for it before opening again.");
      };
      const result = await runTx(openPositionAdapter, {
        poolId: pair.poolAddress,
        inputMint: receipt ? receipt.outputMint : inputMint!,
        inputKind: receipt ? "token" : inputKind,
        amount: receipt ? rawToDecimalString(receipt.delivered, receipt.decimals) : amount,
        requested: (receipt ? receipt.delivered : parsedAmount?.toString()) ?? "",
        rangePreset, minPrice, maxPrice, relayStore: jupiterStoreRef.current,
        solSwapSignature: receipt?.signature, beforeWallet: blockedBeforeWallet,
      }, {
        wallet: txWallet, storage: window.localStorage, isCurrent: current, retry,
        onStage: (stage) => setSubmitStage(stage === "confirming" ? "broadcasting" : stage),
        // Show the exact quote the wallet is about to sign, even if the wallet then refuses.
        onPrepared: (prepared) => setQuote(prepared.summary.quote),
      });
      sent = true;
      setQuote(result.prepared.summary.quote);
      setNow(Date.now());
      open.track(openAttemptFromSummary(result.signature, result.prepared.summary));
      // The receipt is consumed once THIS open confirms (not any other confirmed open on the pool).
      if (receipt) setSwapReceipt({ ...receipt, openSignature: result.signature });
    } catch (caught) {
      const failure = caught instanceof TxRunError ? caught : null;
      if (failure?.kind !== "rejected") {
        captureGrowthEvent(GROWTH_EVENTS.openFailed, {
          ...openEventProperties(pair, { wallet, inputKind }),
          ...openFailureProperties(failure?.cause ?? caught),
          ...(failedStep ? { open_step: failedStep, open_resumed: resume !== null } : {}),
        });
      }
      if (!failure) reportTxFailure({ flow: failedStep === 1 ? "swap" : "open", error: caught, retry });
      // Pipeline errors (incl. the on-chain check after a wallet error) already carry plain words; never show raw wallet JSON.
      const reason = failure ? failure.message
        : caught instanceof TxNotSentError || caught instanceof TxLandedUnknownError || caught instanceof TxSendUnknownError ? plainTxError(caught)
          : jupiterRelayFailureMessage(caught, "Preparing the transaction timed out. Please retry.");
      if (walletRef.current === wallet && failure?.kind !== "rejected") {
        const message = receipt
          ? `Step 1/2 done: ${solSwapReceiptLabel(receipt)} are in your wallet. Step 2/2 (open position) failed: ${reason} Use "Continue open (2/2)" to try step 2/2 again.`
          : caught instanceof SolSwapStepError && caught.signature
            ? `${reason} (swap ${caught.signature.slice(0, 8)}…)`
            : reason;
        setError(message);
        setReprepare(!sent && (failure ? failure.retryable : true));
        if (current()) setRetryError(null);
      }
    } finally {
      // A canceled operation keeps its lock until settlement; release only its own owner.
      if (submittingRef.current === owner) {
        submittingRef.current = null;
        setSubmitStage(null);
        setOpenStep(null);
      }
    }
  }, [amount, busy, fresh, generation, identity, inputRevision, inputRevisionRef, inputKind, inputMint, maxPrice, minPrice, open, pair, parsedAmount, quote, rangePreset, setQuote, setQuoteLoading, txWallet, retry, wallet, activeRef, identityRef, lifetimeRef, jupiterStoreRef, submittingRef, walletRef, setError, setNow, setRetryError, setSubmitStage,
    setOpenStep, setSwapReceipt, swapReceiptRef, setReprepare]);

}
