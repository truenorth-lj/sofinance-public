import "@/lib/engine-host";
import { PublicKey, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { rpcConnection } from "@sofinance/engine/rpc";
import { resetRpcCache } from "@sofinance/engine/rpc/cache";
import { readCompoundBody } from "@/lib/compound-api";
import { confirmedCleanupBatch, parseCleanupBatchSummary } from "@/lib/compound-cleanup-batch";
import { apiError } from "@/lib/api-response";
import type { CleanupBatchConfirmation } from "@/lib/compound-cleanup-batch-types";

export async function POST(request: Request) {
  try {
    const body = await readCompoundBody(request), wallet = parseWallet(body.wallet);
    if (typeof body.signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(body.signature)) throw new Error("Invalid cleanup signature");
    const signature = body.signature, summary = await parseCleanupBatchSummary(body.summary, wallet), connection = rpcConnection();
    const respond = (status: CleanupBatchConfirmation["status"], chainStatus: CleanupBatchConfirmation["chainStatus"]) => {
      if (status === "success") resetRpcCache();
      return Response.json({ signature, status, chainStatus } satisfies CleanupBatchConfirmation, { headers: { "Cache-Control": "no-store" } });
    };
    let observed;
    try { observed = (await connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0]; }
    catch { return respond("pending", "pending"); }
    if (observed && observed.confirmationStatus !== "finalized") return respond("pending", "pending");
    if (observed?.err) return respond("failed", "failed");
    let transaction: ParsedTransactionWithMeta | null;
    try { transaction = await connection.getParsedTransaction(signature, { commitment: "finalized", maxSupportedTransactionVersion: 0 }); }
    catch { return respond("pending", "pending"); }
    if (transaction && transaction.transaction.signatures[0] !== signature) return respond("manual-review", "unknown");
    if (transaction && !transaction.meta || observed && !transaction?.meta) return respond("pending", "pending");
    if (!transaction?.meta) {
      try {
        if (await connection.getBlockHeight("finalized") <= summary.lastValidBlockHeight) return respond("pending", "pending");
        const sources = await connection.getMultipleAccountsInfo(summary.compoundAccounts.map(account => new PublicKey(account.address)), "finalized");
        if (sources.length !== summary.compoundAccounts.length) return respond("pending", "pending");
        // Only a missing signature beyond its validity window with all original
        // sources still present permits expiration. Disappearance is never success.
        return sources.every(info => info !== null) ? respond("expired", "expired") : respond("manual-review", "unknown");
      } catch { return respond("pending", "pending"); }
    }
    if (transaction.meta.err) return respond("failed", "failed");
    let verified = false;
    try { verified = confirmedCleanupBatch(transaction, wallet, summary); } catch { /* Actual receipt mismatch needs review. */ }
    return respond(verified ? "success" : "manual-review", "success");
  } catch (error) { return apiError(error, "Batch cleanup verification failed"); }
}
