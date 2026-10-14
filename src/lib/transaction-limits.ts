import { ComputeBudgetProgram, type VersionedTransaction } from "@solana/web3.js";

/** Solana packet limit for a serialized transaction (single source of truth). */
export const SOLANA_TX_SIZE_LIMIT = 1_232;
/** Compute-unit limit requested by every atomic swap + CLMM transaction. */
export const ATOMIC_COMPUTE_UNIT_LIMIT = 1_400_000;

export const exceedsTxSizeLimit = (bytes: number) => bytes > SOLANA_TX_SIZE_LIMIT;

export const atomicComputeUnitLimitInstruction = () =>
  ComputeBudgetProgram.setComputeUnitLimit({ units: ATOMIC_COMPUTE_UNIT_LIMIT });

export function isZeroSignature(signature: Uint8Array | undefined): boolean {
  return !signature || signature.every((byte) => byte === 0);
}

/** Signed, within the packet limit, exactly one required signer: the wallet as fee payer. */
export function isSingleWalletSignedTransaction(transaction: VersionedTransaction, wallet: string): boolean {
  return !exceedsTxSizeLimit(transaction.serialize().length)
    && transaction.message.staticAccountKeys[0]?.toBase58() === wallet
    && transaction.message.header.numRequiredSignatures === 1
    && transaction.signatures.length === 1
    && !isZeroSignature(transaction.signatures[0]);
}
