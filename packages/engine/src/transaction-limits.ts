import { ComputeBudgetProgram, type VersionedTransaction } from "@solana/web3.js";

/** Solana packet limit for a serialized transaction (single source of truth). */
export const SOLANA_TX_SIZE_LIMIT = 1_232;
/** Compute-unit limit requested by every atomic swap + CLMM transaction. */
export const ATOMIC_COMPUTE_UNIT_LIMIT = 1_400_000;

/**
 * Wallets (Phantom) that add their own priority fee price it per *requested* CU, so a
 * 1.4M limit on a ~65k-CU swap multiplies that fee ~20x. Single-swap steps request the
 * simulated units plus headroom (route drift and wallet-appended guard instructions).
 */
export function measuredComputeUnitLimit(unitsConsumed: number): number {
  if (!Number.isFinite(unitsConsumed) || unitsConsumed <= 0) return ATOMIC_COMPUTE_UNIT_LIMIT;
  const units = Math.ceil(unitsConsumed);
  return Math.min(ATOMIC_COMPUTE_UNIT_LIMIT, units + Math.max(Math.ceil(units / 4), 50_000));
}

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
