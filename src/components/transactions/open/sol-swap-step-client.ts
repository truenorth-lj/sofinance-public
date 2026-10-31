"use client";
// Step 1/2 of a two-transaction SOL deposit (browser side): prepare the
// SOL -> pool-token swap, have the wallet sign and send it, and wait for the
// amount the swap ACTUALLY delivered (read from the confirmed transaction's
// token balances by the server, never from the quote).
import { VersionedTransaction } from "@solana/web3.js";
import { assertSolSwapAttempt, clearSolSwapAttempt, completeSolSwapAttempt, persistSolSwapAttempt,
  readSolSwapAttempt, requireSolSwapStorage, SolSwapStorageError, type SolSwapAttempt, type SolSwapStorage } from "./sol-swap-attempt-store";
import type { PendingSolSwapReceipt } from "./sol-swap-receipt-store";
import type { SolSwapStepSummary } from "@sofinance/engine/sol-swap-step";
import { CANCEL_CHECK_PENDING_COPY, cancelCheckKey, dismissTxNotice, isCancelCheckPending, holdCancelCheck, sendWithWallet, showTxCheckingNotice, trackTxSignature, TxLandedUnknownError,
  TxNotLandedError, TxSendUnknownError, TxWalletCancelledError, walletErrorInfo, watchCancelledSend, type FindLanded, type SendRaw,
  type TxWallet } from "@/lib/tx-pipeline";
import { captureTxWalletErrorLanded, type TxReportContext } from "@/lib/sentry/client-tx";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";

/** "swap-checking": the wallet threw after the sign-and-send request; looking for the swap on-chain before anything else. */
export type SolSwapStage = "swap-preparing" | "swap-wallet" | "swap-checking" | "swap-broadcasting" | "swap-pending";

/** A landed step 1/2: the tokens are in the wallet; step 2/2 opens with exactly `delivered`. */
export type SolSwapReceipt = {
  wallet: string;
  poolId: string;
  signature: string;
  outputMint: string;
  outputSymbol: string | null;
  /** Raw base units delivered by the confirmed swap. */
  delivered: string;
  decimals: number;
};

type Prepared = { unsignedTransaction: string; permit: string; sendPermit?: string; landedPermit?: string; summary: SolSwapStepSummary };
type Delivery = { status: "pending" | "expired" | "failed" } | { status: "confirmed"; delivered: string; decimals: number };

export const SOL_SWAP_POLL_MS = 1_500;
export const SOL_SWAP_CONFIRM_TIMEOUT_MS = 90_000;

/** Exact decimal string of a raw amount (no rounding), for the step 2/2 `amount` field. */
export function rawToDecimalString(raw: string, decimals: number): string {
  const value = BigInt(raw);
  if (decimals === 0) return value.toString();
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export class SolSwapStepError extends Error {
  constructor(message: string, readonly signature: string | null = null) {
    super(message);
    this.name = "SolSwapStepError";
  }
}

/** Public Sentry context of a failed step 1/2 send (blockhash, wallet error code, landed check), for the caller's report. */
const failureContexts = new WeakMap<object, TxReportContext>();
export function solSwapFailureContext(error: unknown): TxReportContext | undefined {
  return error && typeof error === "object" ? failureContexts.get(error) : undefined;
}

export async function runSolSwapStep(input: {
  poolId: string; amount: string; requested: string; store: JupiterRelayStore; timeoutMs: number;
  wallet: TxWallet; sendRaw?: SendRaw;
  setStage: (stage: SolSwapStage) => void; current: () => boolean;
  storage?: SolSwapStorage;
  sleep?: (ms: number) => Promise<void>;
  /** Test hook for the on-chain lookup after a wallet error. */
  findLanded?: FindLanded;
}): Promise<PendingSolSwapReceipt> {
  const wallet = input.wallet.address;
  const { poolId } = input;
  const storage = input.storage ?? requireSolSwapStorage();
  const pending = readSolSwapAttempt(storage, wallet);
  if (pending) throw new SolSwapStepError("Check the original SOL swap before opening again.", pending.signature);
  if (isCancelCheckPending(cancelCheckKey("open", poolId))) throw new SolSwapStepError(CANCEL_CHECK_PENDING_COPY);
  input.setStage("swap-preparing");
  const response = await postWithJupiterRelay("/api/sol-swap-prepare", { wallet, poolId, amount: input.amount },
    { store: input.store, signal: AbortSignal.timeout(input.timeoutMs) });
  const data = await response.json() as Prepared | { error?: string };
  if (!response.ok) throw new Error((data as { error?: string }).error || "SOL swap preparation failed");
  const prepared = data as Prepared;
  const summary = prepared.summary;
  if (!input.current() || !prepared.unsignedTransaction || !prepared.permit || !summary ||
    summary.operation !== "sol-swap-step" || summary.wallet !== wallet || summary.poolId !== poolId ||
    summary.requested !== input.requested) {
    throw new Error("Prepared SOL swap is incomplete. Nothing was sent.");
  }
  const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (c) => c.charCodeAt(0)));
  if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.header.numRequiredSignatures !== 1 ||
    unsigned.message.recentBlockhash !== summary.blockhash) {
    throw new Error("SOL swap transaction payer mismatch");
  }
  if (readSolSwapAttempt(storage, wallet)) throw new Error("SOL swap history changed; check the original transaction.");
  input.setStage("swap-wallet");
  // Shared send stage: the wallet broadcasts (or signs and we send once). The attempt is
  // saved with the returned signature so a reload keeps polling it; nothing is resent.
  let signature: string;
  let checkingId: string | undefined;
  const context: TxReportContext = { blockhash: summary.blockhash };
  try {
    const sent = await sendWithWallet(input.wallet, unsigned, {
      sendRaw: input.sendRaw, sendPermit: prepared.sendPermit, landedPermit: prepared.landedPermit,
      lastValidBlockHeight: summary.lastValidBlockHeight, findLanded: input.findLanded,
      knownSignatures: () => { const saved = readSolSwapAttempt(storage, wallet); return saved ? [saved.signature] : []; },
      onChecking: (walletError) => {
        context.walletErrorCode = walletErrorInfo(walletError).code;
        checkingId = showTxCheckingNotice("swap"); input.setStage("swap-checking");
      },
    });
    signature = sent.signature;
    if (sent.walletError !== undefined) captureTxWalletErrorLanded("swap", { ...context, landedCheck: "landed" });
  } catch (error) {
    if (checkingId) dismissTxNotice(checkingId);
    if (error instanceof TxNotLandedError) context.landedCheck = "not-landed";
    else if (error instanceof TxLandedUnknownError) context.landedCheck = "unknown";
    // Cancelled in the wallet: the caller reports it now; if the swap landed anyway, track it (toast + balances).
    // Until that background check ends, this pool's open (step 1 and 2) cannot be sent again.
    if (error instanceof TxWalletCancelledError) {
      context.walletErrorCode = walletErrorInfo(error.cause).code;
      holdCancelCheck(cancelCheckKey("open", poolId), watchCancelledSend(error, { flow: "swap", successTitle: "Step 1/2 swap confirmed", wallet,
        lastValidBlockHeight: summary.lastValidBlockHeight, context: { ...context } }));
    }
    if (!(error instanceof TxSendUnknownError)) {
      if (error && typeof error === "object") failureContexts.set(error, { ...context });
      throw error;
    }
    signature = error.signature;
  }
  if (checkingId) dismissTxNotice(checkingId);
  const attempt: SolSwapAttempt = { version: 1, wallet, poolId, signature, outputMint: summary.outputMint,
    outputSymbol: summary.outputSymbol, lastValidBlockHeight: summary.lastValidBlockHeight, createdAt: Date.now() };
  persistSolSwapAttempt(storage, attempt);
  input.setStage("swap-broadcasting");
  trackTxSignature({ flow: "swap", signature, lastValidBlockHeight: summary.lastValidBlockHeight, wallet,
    successTitle: "Step 1/2 swap confirmed" });
  input.setStage("swap-pending");
  return reconcileSolSwapStep(attempt, { storage, current: input.current, sleep: input.sleep });
}

/** Read-only recovery. It cannot prepare, sign or resend, and pending attempts never expire by browser time. */
export async function reconcileSolSwapStep(attempt: SolSwapAttempt, options: {
  storage: SolSwapStorage; current: () => boolean; sleep?: (ms: number) => Promise<void>;
}): Promise<PendingSolSwapReceipt> {
  const { wallet, signature, outputMint, lastValidBlockHeight } = attempt;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + SOL_SWAP_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!options.current()) throw new SolSwapStepError("SOL swap tracking paused. Check the original transaction before opening again.", signature);
    assertSolSwapAttempt(options.storage, attempt);
    try {
      const status = await fetch("/api/sol-swap-status", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ wallet, signature, outputMint, lastValidBlockHeight }),
      });
      const result = await status.json() as Delivery | null;
      if (!options.current()) throw new SolSwapStepError("SOL swap tracking paused. Check the original transaction before opening again.", signature);
      assertSolSwapAttempt(options.storage, attempt);
      if (status.ok && result?.status === "confirmed" && typeof result.delivered === "string" &&
        /^[0-9]{1,40}$/.test(result.delivered) && BigInt(result.delivered) > 0n &&
        Number.isSafeInteger(result.decimals) && result.decimals >= 0 && result.decimals <= 18) {
        return completeSolSwapAttempt(options.storage, attempt, { delivered: result.delivered, decimals: result.decimals });
      }
      if (status.ok && (result?.status === "failed" || result?.status === "expired")) {
        clearSolSwapAttempt(options.storage, attempt);
        throw new SolSwapStepError(result.status === "failed"
          ? "Step 1/2 swap failed on-chain. Your SOL was not swapped; nothing was opened."
          : "Step 1/2 swap expired before landing. Your SOL was not swapped; nothing was opened.", signature);
      }
    } catch (error) {
      if (error instanceof SolSwapStepError || error instanceof SolSwapStorageError) throw error;
      // Transient/invalid status response: retain the attempt and continue read-only polling.
    }
    await sleep(SOL_SWAP_POLL_MS);
  }
  throw new SolSwapStepError("Step 1/2 swap is still unconfirmed. Check the original transaction before opening again.", signature);
}
