import "@/lib/engine-host";
import { VersionedTransaction, type Signer } from "@solana/web3.js";
import { isZeroSignature } from "@sofinance/engine/transaction-limits";


/**
 * Wallets sometimes rebuild a VersionedTransaction from the message and only
 * fill the fee-payer slot. Used by the MCP sign-link fallback when the prepared
 * tx already carries an NFT-mint signature. The HTTP app path signs the mint
 * after the wallet instead (Phantom multi-signer recipe).
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

export function assertUnmodifiedMessage(
  prepared: VersionedTransaction | Uint8Array,
  signed: VersionedTransaction,
  message: string,
) {
  const original = prepared instanceof Uint8Array ? prepared : prepared.message.serialize();
  const next = signed.message.serialize();
  if (original.length !== next.length || next.some((byte, index) => byte !== original[index])) {
    throw new Error(message);
  }
}

/**
 * Phantom recipe: wallet signs the unsigned tx first, then other signers are
 * applied to the transaction Phantom returns without changing the message.
 */
export function addMintSignature(walletSigned: VersionedTransaction, mint: Signer): VersionedTransaction {
  const walletSignature = walletSigned.signatures[0] ? Uint8Array.from(walletSigned.signatures[0]) : undefined;
  if (!walletSignature || isZeroSignature(walletSignature)) throw new Error("Wallet did not return a valid signature");
  walletSigned.sign([mint]);
  if (
    isZeroSignature(walletSigned.signatures[0]) ||
    walletSignature.some((byte, index) => byte !== walletSigned.signatures[0]![index])
  ) {
    throw new Error("Adding the NFT mint signature would replace the wallet signature");
  }
  if (isZeroSignature(walletSigned.signatures[1])) {
    throw new Error("Position NFT mint signature missing after local sign");
  }
  return walletSigned;
}
