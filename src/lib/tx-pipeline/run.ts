import type { VersionedTransaction } from "@solana/web3.js";
import { saveTxAttempt } from "./attempts";
import { TxNotSentError, TxSendUnknownError, type TxFlow } from "./errors";
import { noticeIdFor, reportTxFailure, trackTxSignature } from "./notices";
import { sendWithWallet, type SendRaw, type TxWallet } from "./wallet-send";

/**
 * The shared Solana transaction pipeline:
 *   1. prepare  – the flow's adapter builds, simulates and safety-checks a transaction (server side)
 *   2. send     – the wallet signs and sends it (signAndSendTransaction), or signs and we send once
 *   3. confirm  – the notice host polls the signature, then links Solscan and refreshes balances
 *   4. status   – one error classification, toast, Sentry report and signature-keyed saved attempt
 * Flows only supply an adapter: how to prepare, and the words to show.
 */
export type PreparedTx = {
  transaction: VersionedTransaction;
  lastValidBlockHeight: number;
  /** Signers that must sign after the wallet (e.g. a new position's mint keypair). */
  cosign?: (walletSigned: VersionedTransaction) => VersionedTransaction;
  /** Prepare-issued HMAC permit that `/api/tx-send` requires on the relay path. */
  sendPermit?: string;
  /** Release secrets held for cosigning; always called once the run ends. */
  dispose?: () => void;
  positionMint?: string;
};

export type TxAdapter<Input, Prepared extends PreparedTx = PreparedTx> = {
  flow: TxFlow;
  /** Toast title once Solana confirms it, e.g. "Liquidity added". */
  successTitle: string;
  prepare: (input: Input, context: { wallet: string }) => Promise<Prepared>;
  /** Flow-specific bookkeeping right after the network has the signature. Must not throw. */
  onSent?: (signature: string, prepared: Prepared, input: Input) => void;
};

export type TxStage = "preparing" | "wallet" | "confirming";

export type RunTxOptions = {
  wallet: TxWallet;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  sendRaw?: SendRaw;
  onStage?: (stage: TxStage, detail?: { signature?: string }) => void;
  /** Return false once the wallet, inputs or component changed: stop before asking the wallet, and before relaying. */
  isCurrent?: () => boolean;
  retry?: () => void;
};

export type RunTxResult<Prepared> = {
  signature: string; prepared: Prepared; noticeId: string;
  /** The relay response was lost (timeout, network): the signature is tracked but may not have reached Solana. */
  uncertain?: string;
};

export class TxRunError extends Error {
  constructor(readonly kind: ReturnType<typeof reportTxFailure>["kind"], message: string, readonly retryable: boolean, readonly cause: unknown) {
    super(message);
    this.name = "TxRunError";
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
  let prepared: Prepared | undefined;
  let signature: string | undefined;
  let uncertain: string | undefined;
  try {
    options.onStage?.("preparing");
    prepared = await adapter.prepare(input, { wallet: wallet.address });
    if (options.isCurrent && !options.isCurrent()) throw new TxNotSentError("Your wallet or inputs changed, so nothing was sent.");
    options.onPrepared?.(prepared);
    options.onStage?.("wallet");
    try {
      signature = (await sendWithWallet(wallet, prepared.transaction, {
        cosign: prepared.cosign, sendPermit: prepared.sendPermit,
        sendRaw: options.sendRaw, stillWanted: options.isCurrent,
      })).signature;
    } catch (error) {
      if (!(error instanceof TxSendUnknownError)) throw error;
      signature = error.signature; // Possibly sent: track it rather than guess.
      uncertain = error.message;
    }
    const noticeId = record(adapter, input, prepared, signature, options);
    options.onStage?.("confirming", { signature });
    return { signature, prepared, noticeId, ...(uncertain ? { uncertain } : {}) };
  } catch (error) {
    const reported = reportTxFailure({ flow: adapter.flow, error, retry: options.retry });
    throw new TxRunError(reported.kind, reported.message, reported.retryable, error);
  } finally {
    prepared?.dispose?.();
  }
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
}) {
  return runTx({ flow: input.flow, successTitle: input.successTitle, prepare: async () => input.prepared }, undefined,
    { wallet: input.wallet, storage: input.storage, sendRaw: input.sendRaw, retry: input.retry, isCurrent: input.isCurrent });
}
