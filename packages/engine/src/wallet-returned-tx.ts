import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { exceedsTxSizeLimit } from "./transaction-limits";

/** Phantom Lighthouse simulation-assertion program. Extra ixs from this program are allowed. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY");

function programIdOf(transaction: VersionedTransaction, programIdIndex: number): string {
  const staticKeys = transaction.message.staticAccountKeys;
  if (programIdIndex < staticKeys.length) return staticKeys[programIdIndex]!.toBase58();
  let offset = staticKeys.length;
  for (const lookup of transaction.message.addressTableLookups) {
    const count = lookup.writableIndexes.length + lookup.readonlyIndexes.length;
    if (programIdIndex < offset + count) return `${lookup.accountKey.toBase58()}:${programIdIndex - offset}`;
    offset += count;
  }
  return `unknown:${programIdIndex}`;
}

function fingerprints(transaction: VersionedTransaction) {
  return transaction.message.compiledInstructions.map((ix) => ({
    programId: programIdOf(transaction, ix.programIdIndex),
    data: Buffer.from(ix.data).toString("base64"),
    accounts: ix.accountKeyIndexes.map((index) => programIdOf(transaction, index)).join(","),
  }));
}

function isWalletExtraProgram(programId: string) {
  return programId === ComputeBudgetProgram.programId.toBase58() || programId === LIGHTHOUSE_PROGRAM_ID.toBase58();
}

/**
 * Cheap Phantom-compatible check: the wallet-returned tx is the source of truth.
 * Extra ComputeBudget / Lighthouse instructions are allowed. Core program ixs we
 * built (and a fee transfer if present) must still appear in order.
 */
export function walletReturnedTransactionMatches(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
): boolean {
  if (signed.message.staticAccountKeys[0]?.toBase58() !== wallet) return false;
  if (signed.message.recentBlockhash !== prepared.message.recentBlockhash) return false;
  const required = prepared.message.staticAccountKeys.slice(0, prepared.message.header.numRequiredSignatures);
  const signedSigners = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
  if (required.some((key) => !signedSigners.some((next) => next.equals(key)))) return false;
  const core = fingerprints(prepared).filter((ix) => !isWalletExtraProgram(ix.programId));
  let index = 0;
  for (const ix of fingerprints(signed)) {
    if (
      index < core.length &&
      ix.programId === core[index]!.programId &&
      ix.data === core[index]!.data &&
      ix.accounts === core[index]!.accounts
    ) index += 1;
  }
  return index === core.length;
}

export function assertWalletReturnedTransaction(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
) {
  if (signed.message.staticAccountKeys[0]?.toBase58() !== wallet) {
    throw new Error("Wallet changed the transaction fee payer");
  }
  if (signed.message.recentBlockhash !== prepared.message.recentBlockhash) {
    throw new Error("Wallet changed the transaction blockhash");
  }
  const required = prepared.message.staticAccountKeys.slice(0, prepared.message.header.numRequiredSignatures);
  const signedSigners = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
  if (required.some((key) => !signedSigners.some((next) => next.equals(key)))) {
    throw new Error("Wallet dropped a required signer");
  }
  if (!walletReturnedTransactionMatches(prepared, signed, wallet)) {
    throw new Error("Wallet removed or changed a required instruction");
  }
  if (exceedsTxSizeLimit(signed.serialize().length)) {
    throw new Error("Wallet additions exceed the 1,232 byte transaction limit");
  }
}
