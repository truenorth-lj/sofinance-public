"use client";
import "@/lib/engine-host";

import type { AtomicStatus } from "@/lib/attempt-status";
import { dexTxAdapter, type DexDescriptor } from "@/lib/dex/client";
import { createJupiterRelayStore } from "@/lib/jupiter/browser-relay";
import { loadCleanupBatch } from "@/lib/compound-cleanup-batch-attempt";
import { ApiRequestError, resolveCompoundBroadcastFailure } from "@/lib/public-error";
import { pollSignature, runTx, TX_PREFLIGHT_POLICY, TxCancelCheckPendingError, TxLandedUnknownError, TxNotLandedError, TxRunError, TxVoidUnconfirmedError, TxWalletCancelledError, type RunTxOptions, type TxChainStatus, type TxStage, type TxWallet, type WaitVoided } from "@/lib/tx-pipeline";
import { compoundAllFlowFor, type CompoundAllRow, type RowStage } from "@/lib/compound-all/state";
import type { CleanupOutcome, CompoundAllDeps, RowContext, RowOutcome } from "@/lib/compound-all/runner";
import type { PositionKey } from "@/lib/unified-positions/model";
import { abandonUnsentCompoundAttempt, loadCompoundAttempt, loadCompoundReceipts, persistCompoundAttempt, removeConsumedCompoundReceipts,
  removeUnconfirmedCompoundReceipt, type CompoundAttempt, type CompoundPrepared, type CompoundReceipt } from "@sofinance/engine/compound-attempt";
import type { CompoundChainStatus } from "@sofinance/engine/compound-types";
import { beginPositionOp, trackPositionSignature } from "../../unified-positions/position-op-lock";
import { post } from "../compound/compound-client";
import { isSettledStatus, recoveryMayProceed, type AttemptResolution } from "../compound/compound-admission";
import { acceptRaydiumPrepared, requestRaydiumPrepare, sendRaydiumPrepared, type RaydiumSendTarget } from "../compound/raydium-compound-send";

/**
 * Compound all's per-row sends: each one is the position's existing compound flow, unchanged in its transaction,
 * fee and signing. Raydium: `/api/compound-prepare` → `sendAndTrack` → `/api/compound-confirm` (the row's Compound
 * code, extracted into `raydium-compound-send.ts`), with the same prompt void as the preflight flows. Meteora (and any
 * registry DEX that supports compound): `runTx(dexTxAdapter("compound"))` → Solana confirmation. A row is prepared
 * only when the runner calls it, right before its wallet prompt.
 */
type Storage = NonNullable<RunTxOptions["storage"]>;

const stageOf = (stage: TxStage): RowStage => stage === "preparing" ? "preparing" : stage === "wallet" ? "awaiting-wallet" : "confirming";
const text = (error: unknown) => error instanceof Error && error.message ? error.message : "The transaction did not complete.";
export const ROW_STILL_CONFIRMING = "This compound is still confirming. Check it in Activity before trying again.";
export const ROW_LOCKED = "Another transaction on this position is still in progress. Try again when it finishes.";
const CLEANUP_PENDING = "A cleanup of earlier harvest accounts is still being checked. Try again once it settles.";

const walletCancelled = (error: unknown) => error instanceof TxWalletCancelledError ? error
  : error instanceof TxRunError && error.cause instanceof TxWalletCancelledError ? error.cause : null;
const unwrap = (error: unknown) => error instanceof TxRunError && error.cause ? error.cause : error;
/** Flags set from the error's type, not from its message text. */
function unconfirmedFlags(error: unknown): { outcomeUnconfirmed?: boolean; couldntSend?: boolean } {
  const inner = unwrap(error);
  if (inner instanceof TxVoidUnconfirmedError) return { outcomeUnconfirmed: true };
  if (inner instanceof TxLandedUnknownError) return { outcomeUnconfirmed: true, couldntSend: true };
  const cancelled = walletCancelled(error);
  if (cancelled && !cancelled.walletRejected) return { outcomeUnconfirmed: true, couldntSend: true };
  return {};
}

/** A pipeline failure as a row outcome: only a send that cannot have landed may be retried (a retry prepares anew). */
export function rowFailureOf(error: unknown, notSignedYet: boolean): RowOutcome {
  // runTx refused before preparing (a cancelled send of this position is still being checked): nothing was sent, and
  // a Retry now would only be refused again, so the row offers Skip only (PM review of #535).
  if (error instanceof TxCancelCheckPendingError) return { status: "failed", error: error.message, retryable: false, notSigned: true };
  // The wallet threw after we asked it to send, but it was not an explicit "no": the transaction may still land (the
  // pipeline keeps checking Solana). Skip only; the row says "Couldn't send", not "Rejected in wallet" (PM review of #536).
  const cancelled = walletCancelled(error);
  if (cancelled && !cancelled.walletRejected) {
    return { status: "failed", error: error instanceof Error ? error.message : cancelled.message, retryable: false, ...unconfirmedFlags(error) };
  }
  if (error instanceof TxRunError) {
    // The pipeline marks every wallet "no" non-retryable for its toast; in the checklist the user's explicit no is answered with Retry.
    if (error.kind === "rejected") return { status: "rejected", error: error.message, retryable: true };
    // Said no in the wallet and Solana confirmed nothing landed: still the user's no, so Retry asks again.
    if (error.kind === "not-sent" && error.cause instanceof TxNotLandedError && error.cause.walletRejected) {
      return { status: "rejected", error: error.message, retryable: true };
    }
    // Every other kind honors the pipeline's own retryable (e.g. new terms to accept: no Retry).
    if (error.kind === "expired") return { status: "expired", error: error.message, retryable: error.retryable };
    if (error.kind === "not-sent") return { status: "failed", error: error.message, retryable: error.retryable, notSigned: true, ...unconfirmedFlags(error) };
    if (error.kind === "failed") return { status: "failed", error: error.message, retryable: error.retryable, ...unconfirmedFlags(error) };
    return { status: "failed", error: error.message, retryable: false, ...unconfirmedFlags(error) };
  }
  return notSignedYet ? { status: "failed", error: text(error), retryable: true, notSigned: true } : { status: "failed", error: text(error), retryable: false, ...unconfirmedFlags(error) };
}
function chainOutcome(status: TxChainStatus, signature: string): RowOutcome {
  if (status === "confirmed") return { status: "done", signature };
  if (status === "expired") return { status: "expired", error: "The transaction expired before it landed, so nothing changed.", retryable: true };
  if (status === "failed") return { status: "failed", error: "The transaction failed on Solana. Nothing changed except the network fee.", retryable: true };
  return { status: "failed", error: ROW_STILL_CONFIRMING, retryable: false, outcomeUnconfirmed: true };
}

export type ConfirmTiming = { intervalMs?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> };
type CompoundConfirmReply = { status: AtomicStatus; signature: string; chainStatus?: CompoundChainStatus };
const ATOMIC: readonly AtomicStatus[] = ["pending", "expired", "failed", "success", "manual-review"];

/** `/api/compound-confirm` until the compound settles, pruning saved receipts exactly as the row's Compound does. */
async function confirmRaydium(storage: Storage, attempt: CompoundAttempt, timing: ConfirmTiming, onResolved?: (resolution: AttemptResolution) => void): Promise<RowOutcome> {
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + (timing.maxWaitMs ?? 180_000);
  for (;;) {
    let checked: CompoundConfirmReply | null = null;
    try { checked = await post<CompoundConfirmReply>("/api/compound-confirm", { wallet: attempt.wallet, attempt }, AbortSignal.timeout(15_000)); } catch { /* keep polling */ }
    if (checked && (checked.signature !== attempt.signature || !ATOMIC.includes(checked.status))) {
      return { status: "failed", error: "Transaction verification returned signature or status mismatch", retryable: false };
    }
    if (checked) {
      if (isSettledStatus(checked.status)) onResolved?.({ signature: checked.signature, status: checked.status, chainStatus: checked.chainStatus });
      const executed = checked.chainStatus === "success" || checked.status === "success";
      if (checked.status === "success") removeConsumedCompoundReceipts(storage, attempt);
      if (checked.status === "failed" || checked.status === "expired") removeUnconfirmedCompoundReceipt(storage, attempt);
      if (executed) return { status: "done", signature: attempt.signature };
      if (checked.status === "failed") return chainOutcome("failed", attempt.signature);
      if (checked.status === "expired") return chainOutcome("expired", attempt.signature);
      if (checked.status === "manual-review") return { status: "failed", error: "This compound landed but needs verification. Check it in Activity.", retryable: false };
    }
    if (Date.now() >= deadline) return chainOutcome("pending", attempt.signature);
    await sleep(timing.intervalMs ?? 4_000);
  }
}

type RowRefusal = Exclude<RowOutcome, { status: "done" }>;
export const ROW_EARLIER_COMPOUND = "An earlier compound is still being checked on Solana. Retry once it settles, or skip this position.";
export const ROW_RECORDS_INVALID = "Local compound records need verification first. Check them on the position's Compound screen.";

/**
 * The admission the row's Compound and the cleanup batch use (`canStart` in `use-compound-controller.ts`): no new
 * Raydium transaction while the saved compound attempt is unreadable, or not yet settled on Solana. A saved attempt
 * this run has not seen settle is checked once with `/api/compound-confirm` (read-only; nothing is pruned here).
 */
async function savedAttemptAdmission(storage: Storage, wallet: string, resolved: Map<string, AttemptResolution>): Promise<RowRefusal | null> {
  const saved = loadCompoundAttempt(storage, wallet);
  if (saved.invalid) return { status: "failed", error: ROW_RECORDS_INVALID, retryable: false, notSigned: true };
  const attempt = saved.attempt;
  if (!attempt || recoveryMayProceed(resolved.get(attempt.signature) ?? null)) return null;
  let checked: CompoundConfirmReply | null = null;
  try { checked = await post<CompoundConfirmReply>("/api/compound-confirm", { wallet, attempt }, AbortSignal.timeout(15_000)); } catch { /* unknown: not admitted */ }
  if (checked && checked.signature === attempt.signature && ATOMIC.includes(checked.status)) {
    const resolution = { signature: checked.signature, status: checked.status, chainStatus: checked.chainStatus };
    if (recoveryMayProceed(resolution)) { resolved.set(attempt.signature, resolution); return null; }
  }
  return { status: "failed", error: ROW_EARLIER_COMPOUND, retryable: true, notSigned: true };
}

export type RaydiumRowInput = {
  wallet: TxWallet; positionMint: string; storage: Storage; context: RowContext;
  waitVoided?: WaitVoided; signal?: AbortSignal; confirm?: ConfirmTiming;
  /** Called when `/api/compound-confirm` settles this row's compound (success, failed or expired). */
  onResolved?: (resolution: AttemptResolution) => void;
};

/** One Raydium position's compound, bound to nothing but its arguments (no selected position). */
export async function compoundRaydiumPosition(input: RaydiumRowInput): Promise<RowOutcome> {
  const { wallet, positionMint, storage, context } = input;
  const batch = loadCleanupBatch(storage, wallet.address);
  if (batch.invalid || batch.attempt?.transactions.some((tx) => !tx.unsent && !["success", "failed", "expired"].includes(tx.status))) {
    return { status: "failed", error: CLEANUP_PENDING, retryable: true, notSigned: true };
  }
  // Earlier harvest accounts are left to the final cleanup row (and /app/portfolio/recovery), never folded in here.
  const target: RaydiumSendTarget = { kind: "compound", wallet: wallet.address, positionMint, sourceSignatures: [] };
  let created: CompoundAttempt | undefined;
  let persisted = false;
  try {
    const response = await requestRaydiumPrepare(target);
    if (!context.isCurrent()) return { status: "failed", error: "Cancelled before signing, so nothing was sent.", retryable: false, notSigned: true };
    const loaded = acceptRaydiumPrepared(target, response as CompoundPrepared);
    created = await sendRaydiumPrepared(target, loaded, {
      signer: wallet, storage, isCurrent: context.isCurrent,
      onStage: (stage, detail) => context.onStage(stageOf(stage), detail?.signature),
      voidPrompt: TX_PREFLIGHT_POLICY, waitVoided: input.waitVoided, signal: input.signal,
    });
    persistCompoundAttempt(storage, created);
    persisted = true;
  } catch (error) {
    if (created && !persisted) return { status: "failed", error: text(error), retryable: false };
    if (error instanceof TxRunError) return rowFailureOf(error, false);
    const sent = error instanceof ApiRequestError ? error.sent : undefined;
    const outcome = resolveCompoundBroadcastFailure({ persisted, sent, message: text(error) });
    if (outcome.abandon && created) abandonUnsentCompoundAttempt(storage, created);
    // Before a signature exists nothing was sent: a retry prepares a fresh transaction.
    return { status: "failed", error: outcome.error || text(error), retryable: true, notSigned: true };
  }
  context.onStage("confirming", created.signature);
  return confirmRaydium(storage, created, input.confirm ?? {}, input.onResolved);
}

export type RegistryRowInput = {
  wallet: TxWallet; descriptor: DexDescriptor; positionKey: PositionKey; storage: Storage; context: RowContext;
  simulate?: RunTxOptions["simulate"]; waitVoided?: WaitVoided; signal?: AbortSignal;
  poll?: (input: { signature: string; lastValidBlockHeight: number }) => Promise<TxChainStatus>;
  /** Test seam for the position op lock's signature tracking. */
  track?: (positionKey: PositionKey, signature: string) => void;
};

/** One registry-DEX position's compound (Meteora today): the row's own `dexTxAdapter("compound")` through `runTx`. */
export async function compoundRegistryPosition(input: RegistryRowInput): Promise<RowOutcome> {
  const { wallet, descriptor, positionKey, storage, context } = input;
  // runTx threw: whether anything was sent is what the pipeline says.
  const sent = await runTx(dexTxAdapter("compound"),
    { descriptor, positionKey, context: { step: 1, priorSignatures: [] }, relayStore: createJupiterRelayStore() },
    { wallet, storage, scope: positionKey, isCurrent: context.isCurrent, inlineFailure: true,
      onStage: (stage, detail) => context.onStage(stageOf(stage), detail?.signature),
      ...(input.simulate ? { simulate: input.simulate } : {}), ...(input.waitVoided ? { waitVoided: input.waitVoided } : {}),
      ...(input.signal ? { signal: input.signal } : {}) })
    .catch((error: unknown) => ({ unsent: rowFailureOf(error, true) }));
  if ("unsent" in sent) return sent.unsent;
  try {
    // From here runTx has resolved: the transaction was handed to Solana, so no failure below may offer a Retry (a
    // resend). `rowFailureOf(error, false)` = failed, not retryable (PM review of #535).
    (input.track ?? trackPositionSignature)(positionKey, sent.signature);
    if (!sent.prepared.result.done) return { status: "failed", error: "This compound has more steps than expected, so nothing more was sent.", retryable: false };
    context.onStage("confirming", sent.signature);
    const status = await (input.poll ?? pollSignature)({ signature: sent.signature, lastValidBlockHeight: sent.prepared.lastValidBlockHeight });
    return chainOutcome(status, sent.signature);
  } catch (error) {
    // = rowFailureOf(error, false) for anything but a pipeline error, which cannot be thrown here.
    return { status: "failed", error: text(error), retryable: false };
  }
}

export type CompoundAllExecutorOptions = {
  wallet: TxWallet; storage: Storage;
  descriptorFor: (dex: CompoundAllRow["dex"]) => DexDescriptor | null;
  /** The existing cleanup batch (`useCleanupBatchController().start` wired in the UI PR) over the given receipts. */
  cleanupBatch: (receipts: CompoundReceipt[], onStage: (stage: RowStage) => void) => Promise<CleanupOutcome>;
  /** After every Raydium row (whatever its outcome): the selected-position screen re-reads the saved attempt and receipts. */
  onRaydiumSettled?: () => void;
  confirm?: ConfirmTiming;
};

/** The runner's dependencies: every row takes the position's op lock for its whole send, like the row's buttons. */
export function createCompoundAllExecutors(options: CompoundAllExecutorOptions): CompoundAllDeps {
  // Saved Raydium attempts seen settled on Solana in this run (the row's own confirmations and the admission checks).
  const resolved = new Map<string, AttemptResolution>();
  const onResolved = (resolution: AttemptResolution) => { resolved.set(resolution.signature, resolution); };
  async function raydiumRow(row: CompoundAllRow, context: RowContext): Promise<RowOutcome> {
    try {
      const blocked = await savedAttemptAdmission(options.storage, options.wallet.address, resolved);
      if (blocked) return blocked;
      if (!context.isCurrent()) return { status: "failed", error: "Cancelled before signing, so nothing was sent.", retryable: false, notSigned: true };
      return await compoundRaydiumPosition({ wallet: options.wallet, positionMint: row.positionId, storage: options.storage, context, onResolved,
        ...(options.confirm ? { confirm: options.confirm } : {}) });
    } finally {
      options.onRaydiumSettled?.();
    }
  }
  return {
    async runRow(row, context) {
      const release = beginPositionOp(row.key);
      if (!release) return { status: "failed", error: ROW_LOCKED, retryable: true, notSigned: true };
      try {
        // The row's flow must still be what the registry says for its DEX.
        const descriptor = options.descriptorFor(row.dex);
        if (!descriptor || compoundAllFlowFor(descriptor) !== row.flow) return { status: "failed", error: "Compound is not available for this position.", retryable: false, notSigned: true };
        if (row.flow === "native-harvest") return await raydiumRow(row, context);
        return await compoundRegistryPosition({ wallet: options.wallet, descriptor, positionKey: row.key, storage: options.storage, context });
      } finally {
        release();
      }
    },
    async runCleanup(sources, context) {
      const blocked = await savedAttemptAdmission(options.storage, options.wallet.address, resolved);
      if (blocked) return { status: "failed", error: blocked.error };
      const saved = loadCompoundReceipts(options.storage, options.wallet.address);
      if (saved.invalid) return { status: "failed", error: "Local harvest account records need verification before cleanup can continue." };
      const receipts = saved.receipts.filter((receipt) => sources.includes(receipt.sourceSignature));
      // Nothing saved for this run's compounds: their accounts were already merged and closed.
      if (!receipts.length) return { status: "done" };
      return options.cleanupBatch(receipts, context.onStage);
    },
  };
}
