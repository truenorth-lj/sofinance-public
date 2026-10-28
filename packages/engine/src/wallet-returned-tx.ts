import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { exceedsTxSizeLimit } from "./transaction-limits";

/** Phantom Lighthouse simulation-assertion program. Extra ixs from this program are allowed. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY");

const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();

type Fingerprint = {
  programId: string | null;
  data: string;
  accounts: (string | null)[];
};

/** Static-key pubkey, or null when the index is in an address lookup table. */
function resolveKey(transaction: VersionedTransaction, index: number): string | null {
  const staticKeys = transaction.message.staticAccountKeys;
  if (index < staticKeys.length) return staticKeys[index]!.toBase58();
  return null;
}

function isExcludedProgram(programId: string | null): boolean {
  return programId === COMPUTE_BUDGET_PROGRAM || programId === LIGHTHOUSE_PROGRAM_ID.toBase58();
}

function fingerprints(transaction: VersionedTransaction): Fingerprint[] {
  return transaction.message.compiledInstructions.map((ix) => ({
    programId: resolveKey(transaction, ix.programIdIndex),
    data: Buffer.from(ix.data).toString("base64"),
    accounts: ix.accountKeyIndexes.map((index) => resolveKey(transaction, index)),
  }));
}

/** Core ixs we built. ComputeBudget and Lighthouse are never required — the wallet may add, remove, or replace them. */
function coreInstructions(transaction: VersionedTransaction): Fingerprint[] {
  return fingerprints(transaction).filter((ix) => !isExcludedProgram(ix.programId));
}

function instructionMatches(expected: Fingerprint, candidate: Fingerprint): boolean {
  if (expected.data !== candidate.data) return false;
  if (expected.programId && candidate.programId && expected.programId !== candidate.programId) return false;
  if (expected.accounts.length !== candidate.accounts.length) return false;
  for (let index = 0; index < expected.accounts.length; index += 1) {
    const want = expected.accounts[index];
    const got = candidate.accounts[index];
    if (want && got && want !== got) return false;
  }
  return true;
}

function returnedProgramIds(transaction: VersionedTransaction): string[] {
  return fingerprints(transaction).map((ix) => ix.programId ?? "alt");
}

export function walletReturnedTxDiagnostic(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
): { unmatchedIndex: number; unmatchedProgramId: string; returnedProgramIds: string[] } | null {
  const core = coreInstructions(prepared);
  let index = 0;
  for (const ix of fingerprints(signed)) {
    if (index < core.length && instructionMatches(core[index]!, ix)) index += 1;
  }
  if (index === core.length) return null;
  return {
    unmatchedIndex: index,
    unmatchedProgramId: core[index]!.programId ?? "alt",
    returnedProgramIds: returnedProgramIds(signed),
  };
}

function formatMismatch(diagnostic: NonNullable<ReturnType<typeof walletReturnedTxDiagnostic>>): string {
  return `Wallet removed or changed a required instruction (unmatched #${diagnostic.unmatchedIndex} program=${diagnostic.unmatchedProgramId}; returned=[${diagnostic.returnedProgramIds.join(",")}])`;
}

/**
 * Cheap Phantom-compatible check: the wallet-returned tx is the source of truth.
 * Compare resolved program id + data + statically resolvable account pubkeys.
 * Extra / rewritten ComputeBudget or Lighthouse instructions are allowed (subsequence).
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
  return walletReturnedTxDiagnostic(prepared, signed) === null;
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
  const diagnostic = walletReturnedTxDiagnostic(prepared, signed);
  if (diagnostic) {
    const error = new Error(formatMismatch(diagnostic));
    // Diagnostic for the next real-wallet test (program ids only).
    // eslint-disable-next-line no-console -- intended client/server mismatch log
    console.error(error.message);
    throw error;
  }
  if (exceedsTxSizeLimit(signed.serialize().length)) {
    throw new Error("Wallet additions exceed the 1,232 byte transaction limit");
  }
}
