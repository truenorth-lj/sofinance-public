import "@/lib/engine-host";
import bs58 from "bs58";
import { parseCompoundBroadcast } from "@/lib/compound-api";
import { simulateAndVerifyRecovery } from "@sofinance/engine/compound-recovery";
import type { CompoundRecoverySummary } from "@sofinance/engine/compound-recovery-types";
import { rpcConnection } from "@sofinance/engine/rpc";
import { apiError } from "@/lib/api-response";

export async function POST(request: Request) {
  let submitted = false;
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
    submitted = true;
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== expected) throw new Error("RPC returned recovery signature mismatch, please verify on-chain status");
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Once submission starts, transport/retry errors cannot prove the RPC did
    // not accept this signature. Preserve it for on-chain reconciliation.
    const sent = !submitted ? false : undefined;
    return apiError(error, "Recovery broadcast failed", 400, sent === false ? { sent: false } : undefined);
  }
}
