"use client";
// Step 1/2 of a two-transaction SOL deposit (browser side): prepare the
// SOL -> pool-token swap, have the wallet sign it, broadcast, and wait for the
// amount the swap ACTUALLY delivered (read from the confirmed transaction's
// token balances by the server, never from the quote).
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import type { SolSwapStepSummary } from "@sofinance/engine/sol-swap-step";
import { assertWalletReturnedTransaction } from "@/lib/open-signatures";
import { postWithJupiterRelay, type JupiterRelayStore } from "@/lib/jupiter/browser-relay";

export type SolSwapStage = "swap-preparing" | "swap-wallet" | "swap-broadcasting" | "swap-pending";

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

type Prepared = { unsignedTransaction: string; permit: string; summary: SolSwapStepSummary };
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

export async function runSolSwapStep(input: {
  wallet: string; poolId: string; amount: string; requested: string; store: JupiterRelayStore; timeoutMs: number;
  signTransaction: (transaction: VersionedTransaction) => Promise<VersionedTransaction>;
  setStage: (stage: SolSwapStage) => void; current: () => boolean;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SolSwapReceipt> {
  const { wallet, poolId } = input;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  input.setStage("swap-preparing");
  const response = await postWithJupiterRelay("/api/sol-swap-prepare", { wallet, poolId, amount: input.amount },
    { store: input.store, signal: AbortSignal.timeout(input.timeoutMs) });
  const data = await response.json() as Prepared | { error?: string };
  if (!response.ok) throw new Error((data as { error?: string }).error || "SOL swap preparation failed");
  const prepared = data as Prepared;
  const summary = prepared.summary;
  if (!input.current() || !prepared.unsignedTransaction || !prepared.permit || !summary ||
    summary.operation !== "sol-swap-step" || summary.wallet !== wallet || summary.poolId !== poolId ||
    summary.requested !== input.requested || Date.now() >= summary.expiresAt) {
    throw new Error("Prepared SOL swap expired or incomplete");
  }
  const unsigned = VersionedTransaction.deserialize(Uint8Array.from(atob(prepared.unsignedTransaction), (c) => c.charCodeAt(0)));
  const snapshot = VersionedTransaction.deserialize(unsigned.serialize());
  if (unsigned.message.staticAccountKeys[0]?.toBase58() !== wallet || unsigned.message.header.numRequiredSignatures !== 1 ||
    unsigned.message.recentBlockhash !== summary.blockhash) {
    throw new Error("SOL swap transaction payer mismatch");
  }
  input.setStage("swap-wallet");
  const signed = await input.signTransaction(unsigned);
  assertWalletReturnedTransaction(snapshot, signed, wallet);
  if (!input.current() || Date.now() >= summary.expiresAt) throw new Error("Wallet or input changed during signing; swap not sent");
  const signature = bs58.encode(signed.signatures[0]!);
  input.setStage("swap-broadcasting");
  const sent = await fetch("/api/sol-swap-broadcast", {
    method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({
      signedTransaction: btoa(String.fromCharCode(...signed.serialize())),
      unsignedTransaction: prepared.unsignedTransaction, permit: prepared.permit, wallet, summary,
    }),
  });
  const broadcast = await sent.json() as { signature?: string; error?: string; sent?: boolean };
  if (!sent.ok && broadcast.sent === false) throw new Error(broadcast.error || "SOL swap was not sent");
  if (sent.ok && broadcast.signature !== signature) throw new Error("RPC returned transaction signature mismatch");
  // Sent, or possibly sent (lost response): only the chain decides from here.
  input.setStage("swap-pending");
  const deadline = Date.now() + SOL_SWAP_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = await fetch("/api/sol-swap-status", {
        method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({ wallet, signature, outputMint: summary.outputMint, lastValidBlockHeight: summary.lastValidBlockHeight }),
      });
      const result = await status.json() as Delivery & { error?: string };
      if (status.ok && result.status === "confirmed") {
        return { wallet, poolId, signature, outputMint: summary.outputMint, outputSymbol: summary.outputSymbol,
          delivered: result.delivered, decimals: result.decimals };
      }
      if (status.ok && result.status === "failed") {
        throw new SolSwapStepError("Step 1/2 swap failed on-chain. Your SOL was not swapped; nothing was opened.", signature);
      }
      if (status.ok && result.status === "expired") {
        throw new SolSwapStepError("Step 1/2 swap expired before landing. Your SOL was not swapped; nothing was opened.", signature);
      }
    } catch (error) {
      if (error instanceof SolSwapStepError) throw error;
      // Transient status error: keep polling until the deadline.
    }
    await sleep(SOL_SWAP_POLL_MS);
  }
  throw new SolSwapStepError("Step 1/2 swap is still unconfirmed. Check it on Solscan before trying again; if it landed, the tokens are in your wallet.", signature);
}
