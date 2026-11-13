import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import { parseWallet } from "@sofinance/engine/api-input";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { rpcConnection } from "@sofinance/engine/rpc";
import { readCompoundBody } from "@/lib/compound-api";
import { parseCleanupBatchSummary, simulateAndVerifyCleanupBatch, validCleanupSignature, verifyCleanupBatchPermit } from "@/lib/compound-cleanup-batch";
import { assertWalletReturnedTransaction } from "@/lib/wallet-returned-guard";
import { exceedsTxSizeLimit } from "@sofinance/engine/transaction-limits";
import { apiError } from "@/lib/api-response";
import { broadcastSignedTransaction } from "@/lib/broadcast-signed-transaction";

export const maxDuration = 120;

export async function POST(request: Request) {
  let submitted = false;
  try {
    const body = await readCompoundBody(request), wallet = parseWallet(body.wallet);
    if (typeof body.signedTransaction !== "string" || body.signedTransaction.length > 2_500) throw new Error("Invalid signed cleanup transaction");
    const transaction = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
    const prepared = typeof body.unsignedTransaction === "string"
      ? VersionedTransaction.deserialize(Buffer.from(body.unsignedTransaction, "base64"))
      : transaction;
    if (!validCleanupSignature(transaction, wallet)) throw new Error("Cleanup payer, signature or packet size mismatch");
    if (prepared !== transaction) assertWalletReturnedTransaction(prepared, transaction, wallet);
    if (!verifyCleanupBatchPermit(getSigningSecret(), { wallet, summary: body.summary,
      message: Buffer.from(prepared.message.serialize()).toString("base64") }, body.permit)) throw new Error("Cleanup transaction authorization mismatch");
    const summary = await parseCleanupBatchSummary(body.summary, wallet), connection = rpcConnection();
    if (summary.blockhash !== transaction.message.recentBlockhash || exceedsTxSizeLimit(transaction.serialize().length) ||
      Date.now() >= summary.expiresAt || await connection.getBlockHeight("confirmed") > summary.lastValidBlockHeight) throw new Error("Cleanup authorization expired or blockhash mismatch");
    await simulateAndVerifyCleanupBatch({
      connection, transaction, summary, sigVerify: true,
      prepared: prepared !== transaction ? prepared : undefined,
    });
    const signature = await broadcastSignedTransaction({
      connection, transaction,
      expiry: { lastValidBlockHeight: summary.lastValidBlockHeight, expiresAt: summary.expiresAt },
      expiredMessage: "Cleanup transaction expired before broadcast",
      mismatchMessage: "RPC returned cleanup signature mismatch; verify on-chain status",
      onBeforeSend: () => { submitted = true; },
    });
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Once the RPC send starts, even a rate-limit response can follow an
    // accepted submission or retry. Preserve the signed signature for polling.
    const unsent = !submitted;
    return apiError(error, "Batch cleanup broadcast failed", 400, unsent ? { sent: false } : undefined);
  }
}
