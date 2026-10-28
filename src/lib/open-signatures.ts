import "@/lib/engine-host";
import { VersionedTransaction, type Signer } from "@solana/web3.js";
import { isZeroSignature } from "@sofinance/engine/transaction-limits";

export { assertWalletReturnedTransaction } from "./wallet-returned-guard";

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

/**
 * Phantom recipe: wallet signs first, then the mint key signs the wallet-returned
 * (possibly modified) message. The wallet signature stays valid because Phantom
 * signed that same message.
 */
export function addMintSignature(walletSigned: VersionedTransaction, mint: Signer): VersionedTransaction {
  const walletSignature = walletSigned.signatures[0] ? Uint8Array.from(walletSigned.signatures[0]) : undefined;
  if (!walletSignature || isZeroSignature(walletSignature)) throw new Error("Wallet did not return a valid signature");
  const mintIndex = walletSigned.message.staticAccountKeys
    .slice(0, walletSigned.message.header.numRequiredSignatures)
    .findIndex((key) => key.equals(mint.publicKey));
  if (mintIndex < 0) throw new Error("Position NFT mint is not a required signer of the wallet-returned transaction");
  walletSigned.sign([mint]);
  if (
    isZeroSignature(walletSigned.signatures[0]) ||
    walletSignature.some((byte, index) => byte !== walletSigned.signatures[0]![index])
  ) {
    throw new Error("Adding the NFT mint signature would replace the wallet signature");
  }
  if (isZeroSignature(walletSigned.signatures[mintIndex])) {
    throw new Error("Position NFT mint signature missing after local sign");
  }
  return walletSigned;
}
