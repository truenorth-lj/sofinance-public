"use client";
import "@/lib/engine-host";

import { VersionedTransaction } from "@solana/web3.js";
import { sendAndTrack, type RunTxOptions, type TxWallet, type WaitVoided } from "@/lib/tx-pipeline";
import type { CompoundAttempt, CompoundPrepared, CompoundReceipt, RecoveryPrepared } from "@sofinance/engine/compound-attempt";
import type { CompoundSummary } from "@sofinance/engine/compound-types";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { post } from "./compound-client";

/**
 * The Raydium compound (and harvest-account recovery) send, per position: nothing here reads the selected position.
 * `useCompoundController` (the row's Compound) and compound all both call it, so the request, the checks on the
 * prepared transaction and the wallet send are one code path. The transaction is built and simulated on the server
 * (`/api/compound-prepare`); these functions only check it and hand the exact bytes to the wallet.
 */
export type RaydiumSendTarget =
  | { kind: "compound"; wallet: string; positionMint: string; sourceSignatures: string[] }
  | { kind: "recovery"; wallet: string; receipt: CompoundReceipt };
export type AlreadyClosedRecovery = { alreadyClosed: true; wallet: string; accounts: string[] };
export type RaydiumPrepareResponse = CompoundPrepared | RecoveryPrepared | AlreadyClosedRecovery;
export type RaydiumLoaded = { prepared: CompoundPrepared | RecoveryPrepared; summary: CompoundSummary | CompoundRecoverySummary; unsigned: VersionedTransaction };

export function requestRaydiumPrepare(target: RaydiumSendTarget): Promise<RaydiumPrepareResponse> {
  return target.kind === "recovery"
    ? post<RecoveryPrepared | AlreadyClosedRecovery>("/api/compound-recover-prepare", { wallet: target.wallet, compoundAccounts: target.receipt.compoundAccounts })
    : post<CompoundPrepared>("/api/compound-prepare", { wallet: target.wallet, positionMint: target.positionMint, sourceSignatures: target.sourceSignatures });
}

/** The prepared transaction matches the request (operation, wallet, position, payer, blockhash), or this throws. */
export function acceptRaydiumPrepared(target: RaydiumSendTarget, prepared: CompoundPrepared | RecoveryPrepared): RaydiumLoaded {
  const summary = prepared.summary;
  if (!prepared.permit || !summary.simulated ||
    (target.kind === "recovery" ? summary.operation !== "recovery" || (summary as CompoundRecoverySummary).wallet !== target.wallet :
      summary.operation !== "compound" || (summary as CompoundSummary).state.wallet !== target.wallet ||
      (summary as CompoundSummary).positionMint !== target.positionMint)) throw new Error("Simulation result and selection mismatch or expired");
  const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (item) => item.charCodeAt(0)));
  if (unsigned.message.staticAccountKeys[0]?.toBase58() !== target.wallet || unsigned.message.recentBlockhash !== summary.blockhash) {
    throw new Error("Transaction payer or blockhash and preparation result mismatch");
  }
  return { prepared, summary, unsigned };
}

export type RaydiumSendOptions = {
  signer: Pick<TxWallet, "signTransaction" | "signAndSendTransaction">;
  storage: NonNullable<RunTxOptions["storage"]>;
  isCurrent: () => boolean;
  onStage?: RunTxOptions["onStage"];
  /** Compound all: void an unsigned prompt like the preflight flows (absent for the row's Compound, unchanged). */
  voidPrompt?: RunTxOptions["voidPrompt"]; waitVoided?: WaitVoided; signal?: AbortSignal;
};

/** Wallet send through the shared pipeline; returns the attempt to save (not saved here). */
export async function sendRaydiumPrepared(target: RaydiumSendTarget, loaded: RaydiumLoaded, options: RaydiumSendOptions): Promise<CompoundAttempt> {
  const { summary, unsigned } = loaded;
  const receipt = target.kind === "recovery" ? target.receipt : undefined;
  const positionMint = target.kind === "recovery" ? target.receipt.positionMint : target.positionMint;
  // Shared pipeline send stage: the wallet sends (or signs and we relay once). The
  // compound record is saved right after send, keyed by the returned signature.
  const { signature } = await sendAndTrack({
    flow: "compound", successTitle: receipt ? "Cleanup confirmed" : "Compound confirmed", storage: options.storage,
    wallet: { address: target.wallet, signTransaction: options.signer.signTransaction,
      signAndSendTransaction: options.signer.signAndSendTransaction },
    // Only the compound itself goes into the position's history refresh marker (via the confirmation toast). A cleanup
    // tx never touches the position account, so the history sync can never acknowledge its signature.
    prepared: { transaction: unsigned, lastValidBlockHeight: summary.lastValidBlockHeight, ...(receipt ? {} : { positionMint }),
      sendPermit: (loaded.prepared as { sendPermit?: string }).sendPermit,
      landedPermit: (loaded.prepared as { landedPermit?: string }).landedPermit },
    scope: positionMint,
    onStage: options.onStage,
    isCurrent: options.isCurrent,
    ...(options.voidPrompt ? { voidPrompt: options.voidPrompt, waitVoided: options.waitVoided, signal: options.signal } : {}),
  });
  const base = { version: 1 as const, wallet: target.wallet, positionMint, signature, createdAt: Date.now() };
  return receipt
    ? { ...base, kind: "recovery", summary: summary as CompoundRecoverySummary, sourceSignature: receipt.sourceSignature }
    : { ...base, kind: "compound", summary: summary as CompoundSummary };
}
