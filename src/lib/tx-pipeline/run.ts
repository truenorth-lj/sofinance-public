import type { VersionedTransaction } from "@solana/web3.js";
import { loadTxAttempts, saveTxAttempt } from "./attempts";
import { cancelCheckKey, CANCEL_CHECK_PENDING_COPY, holdCancelCheck, isCancelCheckPending } from "./cancel-guard";
import { captureTxPreflightEvent, captureTxWalletErrorLanded, type TxReportContext } from "@/lib/sentry/client-tx";
import { watchCancelledSend } from "./cancelled";
import { isWalletRejection, walletErrorCategory, TxLandedUnknownError, TxNotLandedError, TxNotSentError, TxPreflightError, TxPromptExpiredError, TxSendUnknownError, TxWalletCancelledError, walletErrorInfo, type TxFlow } from "./errors";
import { simulatePreparedOnServer, waitForVoidedExpiry, type SimulatePrepared, type TxPreflightPolicy, type WaitVoided } from "./preflight";
import type { FindLanded } from "./landed";
import { dismissTxNotice, noticeIdFor, reportTxFailure, showTxCheckingNotice, trackTxSignature } from "./notices";
import { sendWithWallet, type SendRaw, type TxWallet } from "./wallet-send";

/**
 * The shared Solana transaction pipeline:
 *   1. prepare  – the flow's adapter builds, simulates and safety-checks a transaction (server side)
 *   2. send     – the wallet signs and sends it (signAndSendTransaction), or signs and we send once (sign-only
 *                 wallets; a step with `presign` is always wallet-sent when the wallet can signAndSend);
 *                 if the wallet throws (any error, even a 4001 cancel), "checking" looks for it on-chain for up to
 *                 20 s; still unseen → "cancelled, retry in about a minute" while that lookup runs on in the background
 *   3. confirm  – the notice host polls the signature, then links Solscan and refreshes balances
 *   4. status   – one error classification, toast, Sentry report and signature-keyed saved attempt
 * Flows only supply an adapter: how to prepare, and the words to show.
 */
export type PreparedTx = {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  /** Signers that must sign after the wallet (e.g. a new position's mint keypair). Forces sign-then-relay unless `presign` is set. */
  cosign?: (walletSigned: VersionedTransaction) => VersionedTransaction;
  /** Signers that sign BEFORE the wallet when it can signAndSend: the wallet then sends it itself (no relay). */
  presign?: (unsigned: VersionedTransaction) => VersionedTransaction;
  /** Prepare-issued HMAC permit that `/api/tx-send` requires on the relay path. */
  sendPermit?: string;
  /** Prepare-issued check permit for `/api/tx-landed` (covers these bytes and `lastValidBlockHeight`). */
  landedPermit?: string;
  /** Release secrets held for cosigning; always called once the run ends. */
  dispose?: () => void;
  positionMint?: string;
};

export type TxAdapter<Input, Prepared extends PreparedTx = PreparedTx> = {
  flow: TxFlow;
  /** Toast title once Solana confirms it, e.g. "Liquidity added". */
  successTitle: string;
  prepare: (input: Input, context: { wallet: string }) => Promise<Prepared>;
  /** What one "same send" is, for blocking a resubmit after a cancel (position mint, pool id). */
  scope?: (input: Input) => string | undefined;
  /** Flow-specific bookkeeping right after the network has the signature. Must not throw. */
  onSent?: (signature: string, prepared: Prepared, input: Input) => void;
  /** Opt into the pre-wallet guard (see `preflight.ts`): simulate, quote age and prompt expiry. Absent: unchanged. */
  preflight?: TxPreflightPolicy;
};

/** Shown when even a fresh prepare is older than the policy allows by the time the wallet would be asked. */
export const STALE_QUOTE_MESSAGE = "Getting a fresh price took too long, so nothing was sent. Try again.";

/** "checking": the wallet threw after a sign-and-send request and we are looking for the transaction on-chain. */
/** "expiring": a voided wallet prompt's transaction could still land; Try again waits until its blockhash expires. */
export type TxStage = "preparing" | "wallet" | "checking" | "expiring" | "confirming";

export type RunTxOptions = {
  wallet: TxWallet;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  sendRaw?: SendRaw;
  onStage?: (stage: TxStage, detail?: { signature?: string; secondsLeft?: number }) => void;
  /** Return false once the wallet, inputs or component changed: stop before asking the wallet, and before relaying. */
  isCurrent?: () => boolean;
  retry?: () => void;
  /** Test hook for the on-chain lookup after a wallet error. */
  findLanded?: FindLanded;
  /** Test hook: the foreground "checking" window (default 20 s). */
  checkingWindowMs?: number;
  /** Test hook: the pre-wallet simulation (default `/api/tx-simulate`). Only used when the adapter has `preflight`. */
  simulate?: SimulatePrepared;
  /** Test hook: after a voided prompt, wait for the old transaction to land or expire (default `/api/tx-expiry`). */
  waitVoided?: WaitVoided;
  /** Aborted when the caller goes away (unmount): the prompt deadline timer and the expiry wait stop. */
  signal?: AbortSignal;
  /** Overrides `adapter.scope` (flows driven through `sendAndTrack`). */
  scope?: string;
  /**
   * The caller shows the failure inline next to its button (with its own Try again), so no failure toast is shown for
   * it (a toast at 375 px would sit on top of that button). Wallet-cancel notices still show (a background check can
   * still turn them into a success).
   */
  inlineFailure?: boolean;
};

export type RunTxResult<Prepared> = {
  signature: string; prepared: Prepared; noticeId: string;
  /** The relay response was lost (timeout, network): the signature is tracked but may not have reached Solana. */
  uncertain?: string;
  /** The wallet threw, but the transaction was found on-chain. */
  landedAfterWalletError?: boolean;
  /** Who broadcast it: the wallet (signAndSend) or our relay (sign-only wallets). Absent when the send is uncertain. */
  via?: "wallet" | "relay";
};

export class TxRunError extends Error {
  constructor(readonly kind: ReturnType<typeof reportTxFailure>["kind"], message: string, readonly retryable: boolean, readonly cause: unknown) {
    super(message);
    this.name = "TxRunError";
  }
}

/** runTx refused before preparing: a cancelled send of this flow + scope is still being checked on-chain. */
export class TxCancelCheckPendingError extends TxRunError {
  constructor() {
    super("rejected", CANCEL_CHECK_PENDING_COPY, false, null);
    this.name = "TxCancelCheckPendingError";
  }
}

export async function runTx<Input, Prepared extends PreparedTx>(
  adapter: TxAdapter<Input, Prepared>, input: Input,
  options: RunTxOptions & {
    /** Called with the prepared transaction right before the wallet is asked (e.g. to show its final quote). */
    onPrepared?: (prepared: Prepared) => void;
  },
): Promise<RunTxResult<Prepared>> {
  const { wallet } = options;
  const guardKey = cancelCheckKey(adapter.flow, options.scope ?? adapter.scope?.(input));
  // A cancelled send of this same flow + position is still being checked on-chain: refuse before preparing.
  if (isCancelCheckPending(guardKey)) throw new TxCancelCheckPendingError();
  let prepared: Prepared | undefined;
  let signature: string | undefined;
  let uncertain: string | undefined;
  let landedAfterWalletError = false;
  let via: "wallet" | "relay" | undefined;
  let checkingId: string | undefined;
  const context: TxReportContext = {};
  try {
    options.onStage?.("preparing");
    const policy = adapter.preflight;
    let quotedAt = Date.now();
    prepared = await adapter.prepare(input, { wallet: wallet.address });
    let preparedAt = Date.now();
    // Pre-wallet guard: one re-prepare (fresh quote and blockhash) for a failed simulation or a stale quote, then stop.
    for (let attempt = 1; policy; attempt++) {
      const simStartedAt = Date.now();
      const sim = await (options.simulate ?? simulatePreparedOnServer)(prepared.transaction,
        { landedPermit: prepared.landedPermit, lastValidBlockHeight: prepared.lastValidBlockHeight });
      // The quote's age excludes our own simulation (a slow public RPC must not force a re-prepare).
      quotedAt += Date.now() - simStartedAt;
      let stop: string | null = null;
      if (sim.ok === false) {
        captureTxPreflightEvent(adapter.flow, "sim-failed", { attempt });
        stop = sim.cause;
      } else {
        // Could not ask Solana (public RPC busy): not a verdict; prepare already simulated these bytes, so go on.
        if (sim.ok === null) captureTxPreflightEvent(adapter.flow, "sim-unavailable", { attempt });
        if (Date.now() - quotedAt > policy.maxQuoteAgeMs) {
          captureTxPreflightEvent(adapter.flow, "stale-quote", { attempt });
          stop = STALE_QUOTE_MESSAGE;
        }
      }
      if (stop === null) break;
      if (attempt >= 2) throw new TxPreflightError(stop);
      if (options.isCurrent && !options.isCurrent()) throw new TxNotSentError("Your wallet or inputs changed, so nothing was sent.");
      prepared.dispose?.();
      prepared = undefined;
      quotedAt = Date.now();
      prepared = await adapter.prepare(input, { wallet: wallet.address });
      preparedAt = Date.now();
    }
    context.blockhash = prepared.transaction.message.recentBlockhash;
    if (options.isCurrent && !options.isCurrent()) throw new TxNotSentError("Your wallet or inputs changed, so nothing was sent.");
    options.onPrepared?.(prepared);
    options.onStage?.("wallet");
    const sentPrepared: Prepared = prepared;
    let lateSignature: string | undefined;
    try {
      const sent = await sendWithWallet(wallet, prepared.transaction, {
        cosign: prepared.cosign, presign: prepared.presign, sendPermit: prepared.sendPermit, landedPermit: prepared.landedPermit,
        sendRaw: options.sendRaw, stillWanted: options.isCurrent,
        lastValidBlockHeight: prepared.lastValidBlockHeight, findLanded: options.findLanded, checkingWindowMs: options.checkingWindowMs,
        ...(policy ? {
          promptDeadlineAt: Math.min(Date.now() + policy.maxPromptMs, preparedAt + policy.blockhashSafeMs),
          // Voided, but this wallet broadcast it anyway: the expiry wait below checks this signature's status.
          onLateSignature: (late: string) => { lateSignature = late; },
          signal: options.signal,
        } : {}),
        knownSignatures: () => options.storage ? loadTxAttempts(options.storage as Storage, wallet.address).map((item) => item.signature) : [],
        onChecking: (walletError) => {
          context.walletErrorCode = walletErrorInfo(walletError).code;
          checkingId = showTxCheckingNotice(adapter.flow);
          options.onStage?.("checking");
        },
      });
      signature = sent.signature;
      via = sent.via;
      if (sent.walletError !== undefined) {
        landedAfterWalletError = true;
        captureTxWalletErrorLanded(adapter.flow, { ...context, landedCheck: "landed" });
      }
    } catch (error) {
      if (policy && error instanceof TxPromptExpiredError) {
        // No double-landing (PM 2026-11-02): the voided transaction can still land until its blockhash expires.
        // Wait for that (Try again stays disabled); if it lands, this step is done and nothing else is sent.
        captureTxPreflightEvent(adapter.flow, "prompt-expired");
        options.onStage?.("expiring");
        const outcome = await (options.waitVoided ?? waitForVoidedExpiry)(sentPrepared.transaction, {
          landedPermit: sentPrepared.landedPermit, lastValidBlockHeight: sentPrepared.lastValidBlockHeight, preparedAt,
          signature: () => lateSignature, signal: options.signal,
          onWaiting: (secondsLeft) => options.onStage?.("expiring", secondsLeft === undefined ? undefined : { secondsLeft }),
        });
        if (outcome.status === "expired") { captureTxPreflightEvent(adapter.flow, "void-expired"); throw error; }
        if (outcome.status === "unknown") throw new TxLandedUnknownError(error);
        captureTxPreflightEvent(adapter.flow, "void-landed");
        signature = outcome.signature;
        via = "wallet";
        landedAfterWalletError = true;
      } else {
        if (!(error instanceof TxSendUnknownError)) throw error;
        signature = error.signature; // Possibly sent: track it rather than guess.
        uncertain = error.message;
      }
    }
    if (checkingId) dismissTxNotice(checkingId);
    const noticeId = record(adapter, input, prepared, signature, options);
    options.onStage?.("confirming", { signature });
    return { signature, prepared, noticeId, ...(uncertain ? { uncertain } : {}), ...(landedAfterWalletError ? { landedAfterWalletError } : {}), ...(via ? { via } : {}) };
  } catch (error) {
    if (error instanceof TxNotLandedError) context.landedCheck = "not-landed";
    else if (error instanceof TxLandedUnknownError) context.landedCheck = "unknown";
    if (error instanceof TxWalletCancelledError) context.walletErrorCode = walletErrorInfo(error.cause).code;
    if (adapter.preflight) countWalletOutcome(adapter.flow, error);
    const reported = reportTxFailure({ flow: adapter.flow, error, id: checkingId, retry: options.retry, context, silent: options.inlineFailure });
    if (error instanceof TxWalletCancelledError && prepared) {
      holdCancelCheck(guardKey, watchCancelledSend(error, { flow: adapter.flow, successTitle: adapter.successTitle, wallet: wallet.address,
        lastValidBlockHeight: prepared.lastValidBlockHeight, storage: options.storage, positionMint: prepared.positionMint,
        retry: options.retry, context: { ...context } }));
    }
    throw new TxRunError(reported.kind, reported.message, reported.retryable, error);
  } finally {
    prepared?.dispose?.();
  }
}

/**
 * (c) Counts only: the user rejecting in the wallet, with the wallet's code and a fixed category of its message
 * (never the text, which can hold an address, amount or signature). Voided prompts are counted where they happen.
 */
function countWalletOutcome(flow: TxFlow, error: unknown) {
  if (error instanceof TxPromptExpiredError) return;
  const walletError = error instanceof TxWalletCancelledError || error instanceof TxNotLandedError ? error.cause : error;
  const rejected = error instanceof TxWalletCancelledError ? error.walletRejected
    : error instanceof TxNotLandedError ? error.walletRejected
    : !(error instanceof TxNotSentError) && isWalletRejection(error);
  if (rejected) captureTxPreflightEvent(flow, "wallet-rejected",
    { walletErrorCode: walletErrorInfo(walletError).code ?? "none", walletErrorCategory: walletErrorCategory(walletError) });
}

function record<Input, Prepared extends PreparedTx>(adapter: TxAdapter<Input, Prepared>, input: Input, prepared: Prepared,
  signature: string, options: RunTxOptions) {
  const attempt = {
    version: 1 as const, flow: adapter.flow, wallet: options.wallet.address, signature,
    lastValidBlockHeight: prepared.lastValidBlockHeight, createdAt: Date.now(), successTitle: adapter.successTitle,
    positionMint: prepared.positionMint,
  };
  if (options.storage) saveTxAttempt(options.storage, attempt);
  try { adapter.onSent?.(signature, prepared, input); } catch { /* bookkeeping must not hide a sent signature */ }
  trackTxSignature({ ...attempt, retry: options.retry });
  return noticeIdFor(signature);
}

/** For flows with their own multi-step state (compound recovery, two-step withdraw): send + track one prepared tx. */
export async function sendAndTrack(input: {
  flow: TxFlow; successTitle: string; wallet: TxWallet; prepared: PreparedTx;
  storage?: RunTxOptions["storage"]; sendRaw?: SendRaw; retry?: () => void; isCurrent?: () => boolean;
  onStage?: RunTxOptions["onStage"]; findLanded?: FindLanded;
  /** Position mint (or other id) for the after-cancel resubmit block. */
  scope?: string;
}) {
  return runTx({ flow: input.flow, successTitle: input.successTitle, prepare: async () => input.prepared }, undefined,
    { wallet: input.wallet, storage: input.storage, sendRaw: input.sendRaw, retry: input.retry, isCurrent: input.isCurrent,
      onStage: input.onStage, findLanded: input.findLanded, scope: input.scope });
}
