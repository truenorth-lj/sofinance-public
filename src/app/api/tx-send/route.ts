import "@/lib/engine-host";
import { VersionedTransaction } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { apiError } from "@/lib/api-response";
import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { rpcConnection } from "@sofinance/engine/rpc";
import { exceedsTxSizeLimit, isZeroSignature } from "@sofinance/engine/transaction-limits";
import { assertWalletReturnedTransaction } from "@sofinance/engine/wallet-returned-tx";
import { verifyTxSendPermit } from "@/lib/tx-send/permit";
import { clientIp, txSendRateLimited } from "@/lib/tx-send/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const MAX_BASE64 = 2_500;

function decode(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.length > MAX_BASE64) throw new Error(`Invalid ${label}`);
  const bytes = Buffer.from(value, "base64");
  if (exceedsTxSizeLimit(bytes.length)) throw new Error(`Invalid ${label}`);
  return VersionedTransaction.deserialize(bytes);
}

/**
 * Fallback send for the shared transaction pipeline, used only when the wallet cannot
 * broadcast itself (no signAndSendTransaction) or a co-signer must sign after the wallet.
 *
 * Checked at send, in order (each refusal is a plain 4xx with `sent: false`, never reported to Sentry):
 * 1. Per-IP rate limit (20 requests / minute / instance) → 429.
 * 2. Send permit: HMAC that prepare issued over the prepared transaction bytes + fee payer; the relay
 *    only forwards transactions this app built (not an open relay).
 * 3. Wallet-returned guard: the signed message keeps the prepared fee payer, blockhash, required
 *    signers and every prepared instruction (wallet-added ComputeBudget / Lighthouse / Memo allowed).
 * 4. Every required signature is present and verifies.
 * Then one sendRawTransaction with preflight and `maxRetries: 3`, so the RPC node rebroadcasts
 * for us; there is no resend loop and no expiry gate (Solana rejects an expired blockhash itself).
 * There is no send-time re-simulation of our own beyond RPC preflight, no liquidity-floor check:
 * those ran at prepare time and the on-chain instruction limits (slippage minimums) still apply.
 */
export async function POST(request: Request) {
  if (txSendRateLimited(clientIp(request))) {
    return Response.json({ error: "Too many transaction submissions. Wait a minute and try again.", sent: false },
      { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } });
  }
  let transaction: VersionedTransaction;
  try {
    const body = await request.json() as { signedTransaction?: unknown; unsignedTransaction?: unknown; sendPermit?: unknown };
    transaction = decode(body?.signedTransaction, "signed transaction");
    const prepared = decode(body?.unsignedTransaction, "prepared transaction");
    const payer = prepared.message.staticAccountKeys[0]?.toBase58();
    const preparedBytes = Buffer.from(String(body.unsignedTransaction), "base64");
    if (!payer || !verifyTxSendPermit(getSigningSecret(), payer, preparedBytes, body?.sendPermit)) {
      throw new Error("This transaction was not prepared by SoFinance, so it was not sent");
    }
    assertWalletReturnedTransaction(prepared, transaction, payer);
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
    return Response.json({ signature }, { headers: NO_STORE });
  } catch (error) {
    // Preflight (simulation / blockhash) refusals are returned before the network sees the bytes: a plain 4xx.
    const preflight = /simulation failed|preflight|blockhash not found|insufficient funds|custom program error/i.test(String((error as Error)?.message ?? ""));
    if (preflight) return apiError(error, "Transaction submission failed", 400, { sent: false });
    // Unknown outcome (network / RPC fault): the bytes may have reached the network. 5xx, reported once.
    return apiError(error, "Transaction submission failed", 502, { transaction: true });
  }
}
