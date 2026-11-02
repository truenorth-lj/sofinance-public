import "server-only";
import type { Connection, VersionedTransaction } from "@solana/web3.js";
import { findLandedTransaction, LandedCheckWindowClosedError, LANDED_EXPIRY_MARGIN_BLOCKS } from "@/lib/tx-landed/lookup";

/**
 * After a voided wallet prompt (pre-wallet guard, PM 2026-11-02): could the old transaction still land? Read on
 * public RPC only. "expired" only once the block height has passed its `lastValidBlockHeight` (plus the lookup's
 * index-lag margin) with no landing found; until then "pending" with the blocks left, so Try again stays disabled.
 * With the wallet's signature, its status decides; without it, the fee payer's recent signatures are matched against
 * the prepared transaction (the expected on-chain effect, `findLandedTransaction`).
 */
export type VoidedTxStatus =
  | { status: "landed" | "failed"; signature: string }
  | { status: "pending"; blocksLeft: number; checked?: string[] }
  | { status: "expired" };

type ExpiryConnection = Pick<Connection, "getBlockHeight" | "getSignatureStatuses" | "getEpochInfo" | "getSignaturesForAddress" | "getTransaction">;

export async function checkVoidedTx(connection: ExpiryConnection, input: {
  wallet: string; prepared: VersionedTransaction; lastValidBlockHeight: number; notBefore: number;
  signature?: string; checked?: readonly string[];
}): Promise<VoidedTxStatus> {
  const height = await connection.getBlockHeight("confirmed");
  const expiresAfter = input.lastValidBlockHeight + LANDED_EXPIRY_MARGIN_BLOCKS;
  const blocksLeft = Math.max(0, expiresAfter - height);
  if (input.signature) {
    const status = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) {
      return { status: status.err ? "failed" : "landed", signature: input.signature };
    }
    return height > expiresAfter ? { status: "expired" } : { status: "pending", blocksLeft };
  }
  try {
    const found = await findLandedTransaction(connection, input);
    if (found.status === "landed" || found.status === "failed") return found;
    if (found.status === "pending") return { status: "pending", blocksLeft, checked: found.checked };
    return { status: "expired" };
  } catch (error) {
    // Hundreds of blocks past expiry: it can no longer land, and every earlier poll found nothing.
    if (error instanceof LandedCheckWindowClosedError) return { status: "expired" };
    throw error;
  }
}
