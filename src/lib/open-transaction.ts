import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, unpackAccount } from "@solana/spl-token";
import { AddressLookupTableAccount, AddressLookupTableProgram, TransactionMessage, VersionedTransaction, type Connection, type TransactionInstruction } from "@solana/web3.js";

const shortVectorSize = (value: number) => value < 128 ? 1 : value < 16_384 ? 2 : 3;
export const MAX_OPEN_TRANSACTION_BYTES = 1_232;

// Measure before serializing: web3.js's fixed buffer throws before it can report
// the length of an oversized message. Includes both wallet and NFT signatures.
export function versionedTransactionSize(transaction: VersionedTransaction) {
  const message = transaction.message;
  if (message.version !== 0) throw new Error("Expected a v0 open-position transaction");
  return shortVectorSize(message.header.numRequiredSignatures) + 64 * message.header.numRequiredSignatures
    + 1 + 3 + shortVectorSize(message.staticAccountKeys.length) + 32 * message.staticAccountKeys.length
    + 32 + shortVectorSize(message.compiledInstructions.length)
    + message.compiledInstructions.reduce((size, ix) => size + 1
      + shortVectorSize(ix.accountKeyIndexes.length) + ix.accountKeyIndexes.length
      + shortVectorSize(ix.data.length) + ix.data.length, 0)
    + shortVectorSize(message.addressTableLookups.length)
    + message.addressTableLookups.reduce((size, lookup) => size + 32
      + shortVectorSize(lookup.writableIndexes.length) + lookup.writableIndexes.length
      + shortVectorSize(lookup.readonlyIndexes.length) + lookup.readonlyIndexes.length, 0);
}

export class OpenTransactionSizeError extends Error {
  constructor(readonly sizeBytes: number) {
    super(`Complete swap + open-position transaction ${sizeBytes} bytes, exceeds 1,232 byte limit; no transaction was sent`);
  }
}

export function assertOpenTransactionSize(transaction: VersionedTransaction) {
  const size = versionedTransactionSize(transaction);
  if (size > MAX_OPEN_TRANSACTION_BYTES) throw new OpenTransactionSizeError(size);
  return size;
}

export function compileCompactOpenTransaction(
  input: ConstructorParameters<typeof TransactionMessage>[0],
  tables: AddressLookupTableAccount[],
) {
  const invoked = new Set(input.instructions.map(ix => ix.programId.toBase58()));
  const signers = new Set([input.payerKey.toBase58(), ...input.instructions.flatMap(ix =>
    ix.keys.filter(key => key.isSigner).map(key => key.pubkey.toBase58()))]);
  const remaining = new Set(input.instructions.flatMap(ix => ix.keys.map(key => key.pubkey.toBase58()))
    .filter(key => !signers.has(key) && !invoked.has(key)));
  const candidates = [...tables];
  const ordered: AddressLookupTableAccount[] = [];
  // Each lookup has a 34-byte overhead. A table covering only one new key
  // costs more than keeping that key inline. Prefer the greatest net saving.
  while (candidates.length) {
    const coverage = candidates.map(table => table.state.addresses.filter(key => remaining.has(key.toBase58())));
    const best = coverage.reduce((index, keys, current) => keys.length > coverage[index]!.length ? current : index, 0);
    if (coverage[best]!.length < 2) break;
    const [table] = candidates.splice(best, 1);
    ordered.push(table!);
    for (const key of coverage[best]!) remaining.delete(key.toBase58());
  }
  const compile = (lookupTables: AddressLookupTableAccount[]) => ({
    transaction: new VersionedTransaction(new TransactionMessage(input).compileToV0Message(lookupTables)),
    tables: lookupTables,
  });
  const original = compile(tables);
  const compact = compile(ordered);
  let best = versionedTransactionSize(compact.transaction) < versionedTransactionSize(original.transaction) ? compact : original;
  // Greedy coverage can miss a smaller union of overlapping tables. At the
  // small table counts returned for a two-leg route, exhaustively choose the
  // subset with the largest net saving; do not enumerate transaction encodings.
  if (tables.length <= 12) {
    const eligible = [...new Set(input.instructions.flatMap(ix => ix.keys.map(key => key.pubkey.toBase58()))
      .filter(key => !signers.has(key) && !invoked.has(key)))];
    const index = new Map(eligible.map((key, offset) => [key, offset]));
    const masks = tables.map(table => table.state.addresses.reduce((mask, key) => {
      const offset = index.get(key.toBase58());
      return offset === undefined ? mask : mask | (1n << BigInt(offset));
    }, 0n));
    const unions: bigint[] = [0n];
    const counts = [0];
    let bestSubset = 0, bestSaving = 0;
    for (let subset = 1; subset < 1 << tables.length; subset++) {
      const bit = subset & -subset;
      const previous = subset ^ bit;
      const tableIndex = 31 - Math.clz32(bit);
      unions[subset] = unions[previous]! | masks[tableIndex]!;
      counts[subset] = counts[previous]! + 1;
      const covered = unions[subset]!.toString(2).replaceAll("0", "").length;
      const saving = 31 * covered - 34 * counts[subset]!;
      if (saving > bestSaving) { bestSaving = saving; bestSubset = subset; }
    }
    const optimal = compile(tables.filter((_, offset) => bestSubset & (1 << offset)));
    if (versionedTransactionSize(optimal.transaction) < versionedTransactionSize(best.transaction)) best = optimal;
  }
  return best;
}

function idempotentAta(ix: TransactionInstruction) {
  if (!ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID) || ix.data.length !== 1 || ix.data[0] !== 1 || ix.keys.length !== 6) return null;
  const [, ata, owner, mint, , program] = ix.keys;
  if (!ata || !owner || !mint || !program ||
    ![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(key => key.equals(program.pubkey)) ||
    !getAssociatedTokenAddressSync(mint.pubkey, owner.pubkey, true, program.pubkey).equals(ata.pubkey)) return null;
  return { ata: ata.pubkey, owner: owner.pubkey, mint: mint.pubkey, program: program.pubkey };
}

// Only remove recognized idempotent ATA creates, never transfers or swaps.
// An explicit close invalidates the cache so later routes can recreate it.
export async function compactAtaInstructions(connection: Connection, instructions: TransactionInstruction[]) {
  const creates = new Map(instructions.flatMap(ix => {
    const ata = idempotentAta(ix);
    return ata ? [[ata.ata.toBase58(), ata] as const] : [];
  }));
  const keys = [...creates.values()];
  const infos = keys.length ? await connection.getMultipleAccountsInfo(keys.map(ata => ata.ata), "confirmed") : [];
  const available = new Set<string>();
  keys.forEach((ata, index) => {
    const info = infos[index];
    if (!info || !info.owner.equals(ata.program)) return;
    try {
      const account = unpackAccount(ata.ata, info, ata.program);
      if (account.isInitialized && account.owner.equals(ata.owner) && account.mint.equals(ata.mint)) available.add(ata.ata.toBase58());
    } catch { /* Keep the create and let simulation reject invalid account data. */ }
  });
  return instructions.filter(ix => {
    const ata = idempotentAta(ix);
    if (ata) {
      const address = ata.ata.toBase58();
      if (available.has(address)) return false;
      available.add(address);
    } else if ([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(program => ix.programId.equals(program)) && ix.data[0] === 9) {
      if (ix.keys[0]) available.delete(ix.keys[0].pubkey.toBase58());
    }
    return true;
  });
}

// Batch lookups and reuse them only within this one preparation. This avoids
// one RPC request per table on every route-budget attempt.
export function openLookupTableReader(connection: Connection) {
  const cache = new Map<string, AddressLookupTableAccount>();
  return async (keys: import("@solana/web3.js").PublicKey[]) => {
    const unique = [...new Map(keys.map(key => [key.toBase58(), key])).values()];
    const missing = unique.filter(key => !cache.has(key.toBase58()));
    if (missing.length) {
      const infos = await connection.getMultipleAccountsInfo(missing, "confirmed");
      missing.forEach((key, index) => {
        const info = infos[index];
        if (!info || !info.owner.equals(AddressLookupTableProgram.programId)) throw new Error(`Address lookup table does not exist: ${key.toBase58()}`);
        const table = new AddressLookupTableAccount({ key, state: AddressLookupTableAccount.deserialize(info.data) });
        if (!table.isActive()) throw new Error("Address lookup table is inactive");
        cache.set(key.toBase58(), table);
      });
    }
    return unique.map(key => cache.get(key.toBase58())!);
  };
}
