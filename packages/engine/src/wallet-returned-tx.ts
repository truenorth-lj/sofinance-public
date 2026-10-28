import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { exceedsTxSizeLimit } from "./transaction-limits";

/** Phantom Lighthouse simulation-assertion program. Extra ixs from this program are allowed. */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPPf4nCVfRTb7cTZo5GsqqY");

const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();

/** `getTransaction` meta.loadedAddresses (writable lookups first, then readonly). */
export type LandedLookupAddresses = {
  writable?: readonly (PublicKey | string)[] | null;
  readonly?: readonly (PublicKey | string)[] | null;
};

export type LandedTransactionReceipt = {
  transaction: { message: VersionedTransaction["message"] };
  meta?: { err: unknown; loadedAddresses?: LandedLookupAddresses | null } | null;
} | null | undefined;

type Fingerprint = {
  programId: string | null;
  data: string;
  accounts: (string | null)[];
};

function pubkeyBase58(value: PublicKey | string): string {
  return typeof value === "string" ? value : value.toBase58();
}

/** Static-key pubkey, or an ALT slot resolved from landed `loadedAddresses`. */
function resolveKey(
  transaction: VersionedTransaction,
  index: number,
  loadedAddresses?: LandedLookupAddresses | null,
): string | null {
  const staticKeys = transaction.message.staticAccountKeys;
  if (index < staticKeys.length) return staticKeys[index]!.toBase58();
  if (!loadedAddresses) return null;
  const altIndex = index - staticKeys.length;
  const writable = loadedAddresses.writable ?? [];
  if (altIndex < writable.length) return pubkeyBase58(writable[altIndex]!);
  const readonly = loadedAddresses.readonly ?? [];
  const readonlyIndex = altIndex - writable.length;
  if (readonlyIndex < readonly.length) return pubkeyBase58(readonly[readonlyIndex]!);
  return null;
}

function isExcludedProgram(programId: string | null): boolean {
  return programId === COMPUTE_BUDGET_PROGRAM || programId === LIGHTHOUSE_PROGRAM_ID.toBase58();
}

function fingerprints(
  transaction: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): Fingerprint[] {
  return transaction.message.compiledInstructions.map((ix) => ({
    programId: resolveKey(transaction, ix.programIdIndex, loadedAddresses),
    data: Buffer.from(ix.data).toString("base64"),
    accounts: ix.accountKeyIndexes.map((index) => resolveKey(transaction, index, loadedAddresses)),
  }));
}

/** Core ixs we built. ComputeBudget and Lighthouse are never required — the wallet may add, remove, or replace them. */
function coreInstructions(
  transaction: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): Fingerprint[] {
  return fingerprints(transaction, loadedAddresses).filter((ix) => !isExcludedProgram(ix.programId));
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

function returnedProgramIds(
  transaction: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): string[] {
  return fingerprints(transaction, loadedAddresses).map((ix) => ix.programId ?? "alt");
}

export function walletReturnedTxDiagnostic(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): { unmatchedIndex: number; unmatchedProgramId: string; returnedProgramIds: string[] } | null {
  const core = coreInstructions(prepared);
  let index = 0;
  for (const ix of fingerprints(signed, loadedAddresses)) {
    if (index < core.length && instructionMatches(core[index]!, ix)) index += 1;
  }
  if (index === core.length) return null;
  return {
    unmatchedIndex: index,
    unmatchedProgramId: core[index]!.programId ?? "alt",
    returnedProgramIds: returnedProgramIds(signed, loadedAddresses),
  };
}

function formatMismatch(diagnostic: NonNullable<ReturnType<typeof walletReturnedTxDiagnostic>>): string {
  return `Wallet removed or changed a required instruction (unmatched #${diagnostic.unmatchedIndex} program=${diagnostic.unmatchedProgramId}; returned=[${diagnostic.returnedProgramIds.join(",")}])`;
}

function requiredSignersPresent(prepared: VersionedTransaction, signed: VersionedTransaction): boolean {
  const required = prepared.message.staticAccountKeys.slice(0, prepared.message.header.numRequiredSignatures);
  const signedSigners = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
  return !required.some((key) => !signedSigners.some((next) => next.equals(key)));
}

/**
 * Cheap Phantom-compatible check: the wallet-returned (or landed) tx is the source of truth.
 * Compare resolved program id + data + resolvable account pubkeys.
 * Extra / rewritten ComputeBudget or Lighthouse instructions are allowed (subsequence).
 * Pass `loadedAddresses` from `getTransaction` meta to resolve landed ALT slots.
 */
export function walletReturnedTransactionMatches(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
  loadedAddresses?: LandedLookupAddresses | null,
): boolean {
  if (signed.message.staticAccountKeys[0]?.toBase58() !== wallet) return false;
  if (signed.message.recentBlockhash !== prepared.message.recentBlockhash) return false;
  if (!requiredSignersPresent(prepared, signed)) return false;
  return walletReturnedTxDiagnostic(prepared, signed, loadedAddresses) === null;
}

/** Landed `getTransaction` receipt vs the permit-bound prepared message. */
export function landedTransactionMatchesPrepared(
  prepared: VersionedTransaction,
  receipt: LandedTransactionReceipt,
  wallet: string,
): boolean {
  if (!receipt?.meta || receipt.meta.err) return false;
  try {
    const landed = new VersionedTransaction(receipt.transaction.message);
    return walletReturnedTransactionMatches(prepared, landed, wallet, receipt.meta.loadedAddresses);
  } catch {
    return false;
  }
}

export function assertWalletReturnedTransaction(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  wallet: string,
  loadedAddresses?: LandedLookupAddresses | null,
) {
  if (signed.message.staticAccountKeys[0]?.toBase58() !== wallet) {
    throw new Error("Wallet changed the transaction fee payer");
  }
  if (signed.message.recentBlockhash !== prepared.message.recentBlockhash) {
    throw new Error("Wallet changed the transaction blockhash");
  }
  if (!requiredSignersPresent(prepared, signed)) {
    throw new Error("Wallet dropped a required signer");
  }
  const diagnostic = walletReturnedTxDiagnostic(prepared, signed, loadedAddresses);
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
