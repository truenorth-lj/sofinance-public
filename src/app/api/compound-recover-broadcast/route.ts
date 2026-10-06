import bs58 from "bs58";
import { parseCompoundBroadcast } from "@/lib/compound-api";
import { simulateAndVerifyRecovery } from "@/lib/compound-recovery";
import type { CompoundRecoverySummary } from "@/lib/compound-recovery-types";
import { rpcConnection } from "@/lib/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  try {
    const { wallet, summary: approved, transaction } = await parseCompoundBroadcast(request, "recovery");
    const summary = approved as CompoundRecoverySummary;
    const connection = rpcConnection();
    if (summary.wallet !== wallet || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) {
      throw new Error("Recovery authorization wallet or blockhash mismatch");
    }
    await simulateAndVerifyRecovery({ connection, transaction, summary, sigVerify: true });
    if (Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) {
      throw new Error("Recovery transaction expired before broadcast");
    }
    const expected = bs58.encode(transaction.signatures[0]!);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expected) throw new Error("RPC returned recovery signature mismatch, please verify on-chain status");
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error, "Recovery broadcast failed"); }
}
