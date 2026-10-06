import "server-only";

import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { parseWallet } from "./api-input";
import { verifyCompoundPermit } from "./compound-permit";
import type { CompoundSummary } from "./compound-types";
import type { CompoundRecoverySummary } from "./compound-recovery-types";

export async function readCompoundBody(request: Request) {
  const text = await request.text();
  if (text.length > 30_000) throw new Error("Compound request too large");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid compound input");
  return parsed as Record<string, unknown>;
}

export async function parseCompoundSelection(request: Request) {
  const body = await readCompoundBody(request);
  const wallet = parseWallet(body.wallet);
  if (typeof body.positionMint !== "string" || new PublicKey(body.positionMint).toBase58() !== body.positionMint) {
    throw new Error("Invalid position mint");
  }
  const sourceSignatures = body.sourceSignatures ?? [];
  if (!Array.isArray(sourceSignatures) || sourceSignatures.length > 3 || sourceSignatures.some((signature) =>
    typeof signature !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) ||
    new Set(sourceSignatures).size !== sourceSignatures.length) throw new Error("Invalid yield source transactions; maximum three merges per attempt");
  return { wallet, positionMint: body.positionMint, sourceSignatures: sourceSignatures as string[] };
}

export async function parseCompoundBroadcast(request: Request, operation: "compound" | "recovery") {
  const body = await readCompoundBody(request);
  const wallet = parseWallet(body.wallet);
  if (typeof body.signedTransaction !== "string" || body.signedTransaction.length > 2_500) {
    throw new Error("Invalid signed transaction input");
  }
  const transaction = VersionedTransaction.deserialize(Buffer.from(body.signedTransaction, "base64"));
  if (transaction.serialize().length > 1_232 || transaction.message.staticAccountKeys[0]?.toBase58() !== wallet ||
    transaction.message.header.numRequiredSignatures !== 1 || transaction.signatures.length !== 1 ||
    !transaction.signatures[0] || transaction.signatures[0].every((byte) => byte === 0)) {
    throw new Error("Compound payer, signature, or transaction size mismatch");
  }
  if (!verifyCompoundPermit(process.env.JUPITER_API_KEY || "", {
    wallet, message: Buffer.from(transaction.message.serialize()).toString("base64"), summary: body.summary,
  }, body.permit)) throw new Error("Transaction does not match simulated compound authorization");
  // Summary fields become trusted only after the complete HMAC is verified.
  const summary = body.summary as CompoundSummary | CompoundRecoverySummary;
  if (summary.operation !== operation || !Number.isSafeInteger(summary.expiresAt) || summary.expiresAt <= Date.now() ||
    !Number.isSafeInteger(summary.lastValidBlockHeight) || summary.lastValidBlockHeight <= 0 ||
    summary.blockhash !== transaction.message.recentBlockhash ||
    (summary.operation === "compound" ? summary.state.wallet : summary.wallet) !== wallet) {
    throw new Error("Compound authorization type, wallet, or expiry mismatch");
  }
  return { wallet, summary, transaction };
}
