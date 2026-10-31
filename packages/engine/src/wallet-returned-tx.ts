import { ComputeBudgetProgram, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { exceedsTxSizeLimit } from "./transaction-limits";

/**
 * Lighthouse assertion program (mainnet + devnet), which Phantom inserts into transactions it signs.
 * Source: github.com/Jac0xb/lighthouse README "Addresses".
 */
export const LIGHTHOUSE_PROGRAM_ID = new PublicKey("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");
export const MEMO_V2_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
export const MEMO_V1_PROGRAM_ID = new PublicKey("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo");

const COMPUTE_BUDGET_PROGRAM = ComputeBudgetProgram.programId.toBase58();

/**
 * The one allow-list for instructions a wallet may add to a transaction we prepared, used by the client
 * check, every server-side wallet-returned check and the strict `/api/tx-send` comparison. The program
 * must be a static account key (a v0 program id can not come from a lookup table anyway).
 */
export const WALLET_EXTRA_PROGRAM_IDS: ReadonlySet<string> = new Set([
  COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM_ID.toBase58(), MEMO_V2_PROGRAM_ID.toBase58(), MEMO_V1_PROGRAM_ID.toBase58(),
]);

/** ComputeBudget / Lighthouse in the prepared tx are not required: the wallet may replace or drop them. */
const REPLACEABLE_PROGRAM_IDS: ReadonlySet<string> = new Set([COMPUTE_BUDGET_PROGRAM, LIGHTHOUSE_PROGRAM_ID.toBase58()]);

/** Program id of an instruction, only if it is a static key in the allow-list. */
export function isAllowedWalletExtraProgram(programId: string | null, isStaticKey: boolean): boolean {
  return isStaticKey && programId !== null && WALLET_EXTRA_PROGRAM_IDS.has(programId);
}

/**
 * The shared matching rule. Walk the signed instructions in order: one that matches the next required
 * (prepared) instruction advances; any other must be an allowed wallet extra. Returns how many required
 * instructions matched and the first signed instruction that is neither.
 */
export function walkWalletReturnedInstructions<T>(
  required: readonly T[],
  signed: readonly T[],
  matches: (expected: T, candidate: T) => boolean,
  isAllowedExtra: (candidate: T) => boolean,
): { matched: number; firstDisallowedIndex: number | null } {
  let matched = 0;
  let firstDisallowedIndex: number | null = null;
  signed.forEach((ix, index) => {
    if (matched < required.length && matches(required[matched]!, ix)) matched += 1;
    else if (!isAllowedExtra(ix) && firstDisallowedIndex === null) firstDisallowedIndex = index;
  });
  return { matched, firstDisallowedIndex };
}

/** Prepared instructions that must survive signing (everything but ComputeBudget / Lighthouse). */
export function isRequiredPreparedProgram(programId: string | null, isStaticKey: boolean): boolean {
  return !(isStaticKey && programId !== null && REPLACEABLE_PROGRAM_IDS.has(programId));
}

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
  programIsStatic: boolean;
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

function fingerprints(
  transaction: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): Fingerprint[] {
  return transaction.message.compiledInstructions.map((ix) => ({
    programId: resolveKey(transaction, ix.programIdIndex, loadedAddresses),
    programIsStatic: ix.programIdIndex < transaction.message.staticAccountKeys.length,
    data: Buffer.from(ix.data).toString("base64"),
    accounts: ix.accountKeyIndexes.map((index) => resolveKey(transaction, index, loadedAddresses)),
  }));
}

/** Core ixs we built. ComputeBudget and Lighthouse are never required — the wallet may add, remove, or replace them. */
function coreInstructions(
  transaction: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): Fingerprint[] {
  return fingerprints(transaction, loadedAddresses).filter((ix) => isRequiredPreparedProgram(ix.programId, ix.programIsStatic));
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

export function walletReturnedTxDiagnostic(
  prepared: VersionedTransaction,
  signed: VersionedTransaction,
  loadedAddresses?: LandedLookupAddresses | null,
): { kind: "missing" | "extra"; unmatchedIndex: number; unmatchedProgramId: string; returnedProgramIds: string[] } | null {
  const core = coreInstructions(prepared);
  const returned = fingerprints(signed, loadedAddresses);
  const { matched, firstDisallowedIndex } = walkWalletReturnedInstructions(core, returned, instructionMatches,
    (ix) => isAllowedWalletExtraProgram(ix.programId, ix.programIsStatic));
  const returnedProgramIds = returned.map((ix) => ix.programId ?? "alt");
  if (matched < core.length) {
    return { kind: "missing", unmatchedIndex: matched, unmatchedProgramId: core[matched]!.programId ?? "alt", returnedProgramIds };
  }
  if (firstDisallowedIndex !== null) {
    return { kind: "extra", unmatchedIndex: firstDisallowedIndex, unmatchedProgramId: returned[firstDisallowedIndex]!.programId ?? "alt", returnedProgramIds };
  }
  return null;
}

function formatMismatch(diagnostic: NonNullable<ReturnType<typeof walletReturnedTxDiagnostic>>): string {
  const detail = `#${diagnostic.unmatchedIndex} program=${diagnostic.unmatchedProgramId}; returned=[${diagnostic.returnedProgramIds.join(",")}]`;
  return diagnostic.kind === "missing"
    ? `Wallet removed or changed a required instruction (unmatched ${detail})`
    : `Wallet added an instruction from a program that is not allowed (${detail})`;
}

function requiredSignersPresent(prepared: VersionedTransaction, signed: VersionedTransaction): boolean {
  const required = prepared.message.staticAccountKeys.slice(0, prepared.message.header.numRequiredSignatures);
  const signedSigners = signed.message.staticAccountKeys.slice(0, signed.message.header.numRequiredSignatures);
  return !required.some((key) => !signedSigners.some((next) => next.equals(key)));
}

/**
 * Cheap Phantom-compatible check: the wallet-returned (or landed) tx is the source of truth.
 * Compare resolved program id + data + resolvable account pubkeys.
 * Instructions the wallet adds must come from `WALLET_EXTRA_PROGRAM_IDS` (ComputeBudget, Lighthouse, Memo).
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
