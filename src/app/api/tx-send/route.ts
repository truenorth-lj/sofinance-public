import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiError } from "@/lib/api-response";
import { rpcConnection } from "@sofinance/engine/rpc";
import { exceedsTxSizeLimit, isZeroSignature } from "@sofinance/engine/transaction-limits";

/**
 * Fallback send for the shared transaction pipeline, used only when the wallet cannot
 * broadcast itself (no signAndSendTransaction) or a co-signer must sign after the wallet.
 * One plain sendRawTransaction with preflight; no resend loop and no expiry gate (Solana
 * rejects an expired blockhash itself). Every safety check ran at prepare time; here we
 * only refuse malformed or incompletely signed bytes. A preflight refusal is `sent: false`.
 */
export async function POST(request: Request) {
  let transaction: VersionedTransaction;
  try {
    const body = await request.json() as { signedTransaction?: unknown };
    if (typeof body?.signedTransaction !== "string" || body.signedTransaction.length > 2_500) throw new Error("Invalid signed transaction");
    const bytes = Buffer.from(body.signedTransaction, "base64");
    if (exceedsTxSizeLimit(bytes.length)) throw new Error("Invalid signed transaction");
    transaction = VersionedTransaction.deserialize(bytes);
    const message = transaction.message.serialize();
    const required = transaction.message.header.numRequiredSignatures;
    if (required < 1 || transaction.signatures.length !== required) throw new Error("Invalid signed transaction");
    for (let index = 0; index < required; index++) {
      const signature = transaction.signatures[index];
      const signer = transaction.message.staticAccountKeys[index];
      if (!signer || isZeroSignature(signature) || !nacl.sign.detached.verify(message, signature!, signer.toBytes())) {
        throw new Error("A required signature is missing or invalid");
      }
    }
  } catch (error) {
    return apiError(error, "Transaction submission failed", 400, { sent: false });
  }
  try {
    const signature = await rpcConnection().sendRawTransaction(transaction.serialize(), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    if (signature !== bs58.encode(transaction.signatures[0]!)) throw new Error("RPC returned a different signature");
    return Response.json({ signature }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    // Preflight (simulation / blockhash) refusals are returned before the network sees the bytes.
    const preflight = /simulation failed|preflight|blockhash not found|insufficient funds|custom program error/i.test(String((error as Error)?.message ?? ""));
    return apiError(error, "Transaction submission failed", 400, { transaction: true, ...(preflight ? { sent: false } : {}) });
  }
}
