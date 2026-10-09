import { VersionedTransaction } from "@solana/web3.js";

function isZeroSignature(signature: Uint8Array | undefined): boolean {
  return !signature || signature.every((byte) => byte === 0);
}

/**
 * Wallets sometimes rebuild a VersionedTransaction from the message and only
 * fill the fee-payer slot, dropping the server's NFT-mint partial signature.
 * Copy any non-zero extra signatures from the prepared tx back onto the signed tx.
 */
export function preserveExtraSignatures(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
): VersionedTransaction {
  if (signed.signatures.length !== prepared.signatures.length) {
    throw new Error("Wallet returned a different signature count than the prepared transaction");
  }
  for (let index = 0; index < prepared.signatures.length; index += 1) {
    const original = prepared.signatures[index];
    const next = signed.signatures[index];
    if (!original || isZeroSignature(original)) continue;
    if (isZeroSignature(next)) {
      signed.signatures[index] = Uint8Array.from(original);
    }
  }
  return signed;
}

export function requiredSignerCount(transaction: VersionedTransaction): number {
  return transaction.message.header.numRequiredSignatures;
}

export function missingRequiredSignatures(transaction: VersionedTransaction): number[] {
  const missing: number[] = [];
  const required = requiredSignerCount(transaction);
  for (let index = 0; index < required; index += 1) {
    if (isZeroSignature(transaction.signatures[index])) missing.push(index);
  }
  return missing;
}
