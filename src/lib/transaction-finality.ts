import "@/lib/engine-host";
import "server-only";
import type { Connection } from "@solana/web3.js";
export { isSolanaSignature } from "./solana-signature";

type FinalityCommitment = "confirmed" | "finalized";
/**
 * `unknown`: Solana has no record of the signature and no `lastValidBlockHeight` was given, so it cannot tell
 * "still in flight" from "never landed". Only the MCP `tx_status` tool can return it (the route requires the height).
 */
export type FinalityStatus = "finalized" | "confirmed" | "failed" | "pending" | "expired" | "unknown";
type FinalityResult = { status: FinalityStatus; slot: number | null };

/**
 * Read-only signature status, shared by `POST /api/transaction-finality` and the MCP `tx_status` tool.
 * One `getSignatureStatuses` call (with transaction history, so older signatures are found); one extra
 * `getBlockHeight` only when the signature is not found and a `lastValidBlockHeight` was given.
 * With `commitment: "confirmed"` a landed transaction reports "confirmed" as soon as the cluster confirms it;
 * otherwise it waits for "finalized". A transaction error is "failed" at any commitment. "expired" means Solana
 * never saw the signature and the confirmed block height has passed `lastValidBlockHeight`, so it can no longer land.
 */
export async function readSignatureFinality(connection: Pick<Connection, "getSignatureStatuses" | "getBlockHeight">, input: {
  signature: string;
  lastValidBlockHeight?: number;
  commitment?: FinalityCommitment;
}): Promise<FinalityResult> {
  const observed = (await connection.getSignatureStatuses([input.signature], { searchTransactionHistory: true })).value[0];
  const slot = observed ? observed.slot ?? null : null;
  if (observed?.err) return { status: "failed", slot };
  if (observed?.confirmationStatus === "finalized") return { status: "finalized", slot };
  if (input.commitment === "confirmed" && observed?.confirmationStatus === "confirmed") return { status: "confirmed", slot };
  if (observed) return { status: "pending", slot };
  if (input.lastValidBlockHeight === undefined) return { status: "unknown", slot: null };
  const height = await connection.getBlockHeight("confirmed");
  return { status: height > input.lastValidBlockHeight ? "expired" : "pending", slot: null };
}
