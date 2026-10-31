import "@/lib/engine-host";
import type { MessageAddressTableLookup, PublicKey, VersionedTransaction } from "@solana/web3.js";
import {
  isAllowedWalletExtraProgram, isRequiredPreparedProgram, walkWalletReturnedInstructions,
} from "@sofinance/engine/wallet-returned-tx";

/**
 * Strict server-side comparison for `/api/tx-send` (stricter than the client/landed guard, which
 * tolerates any extra instruction and skips unresolvable lookup-table accounts):
 * - same rule and allow-list as the engine/client check (`walkWalletReturnedInstructions`,
 *   `WALLET_EXTRA_PROGRAM_IDS`): every prepared instruction (except ComputeBudget / Lighthouse, which a
 *   wallet may replace) must appear unchanged and in order: same program, data and accounts; any other
 *   instruction must come from ComputeBudget, Lighthouse or Memo by a static key, so e.g. an inserted
 *   SystemProgram.transfer is refused;
 * - lookup-table accounts are never skipped: if the signed transaction keeps the prepared table
 *   lookups exactly, slots are compared as slots (same table, same index, same address); otherwise
 *   every table is resolved and accounts are compared as addresses, and an unresolvable table is refused.
 */
export type ResolveLookupTable = (table: PublicKey) => Promise<readonly PublicKey[] | null>;

export class RelayMismatchError extends Error {}

type Key = { label: string; isStatic: boolean };
type Ix = { program: Key; data: string; accounts: string[] };

function sameLookups(a: readonly MessageAddressTableLookup[], b: readonly MessageAddressTableLookup[]) {
  return a.length === b.length && a.every((lookup, index) => {
    const other = b[index]!;
    return lookup.accountKey.equals(other.accountKey)
      && Buffer.from(lookup.writableIndexes).equals(Buffer.from(other.writableIndexes))
      && Buffer.from(lookup.readonlyIndexes).equals(Buffer.from(other.readonlyIndexes));
  });
}

/** Loaded-address order: every table's writable indexes, then every table's readonly indexes. */
function lookupSlots(lookups: readonly MessageAddressTableLookup[]) {
  return [
    ...lookups.flatMap((lookup) => [...lookup.writableIndexes].map((index) => ({ table: lookup.accountKey, index }))),
    ...lookups.flatMap((lookup) => [...lookup.readonlyIndexes].map((index) => ({ table: lookup.accountKey, index }))),
  ];
}

async function keyResolver(transaction: VersionedTransaction, mode: "slots" | "addresses", resolve: ResolveLookupTable,
  tables: Map<string, Promise<readonly PublicKey[] | null>>) {
  const staticKeys = transaction.message.staticAccountKeys;
  const slots = lookupSlots(transaction.message.addressTableLookups);
  const loaded: string[] = [];
  for (const slot of slots) {
    if (mode === "slots") { loaded.push(`alt:${slot.table.toBase58()}#${slot.index}`); continue; }
    const id = slot.table.toBase58();
    if (!tables.has(id)) tables.set(id, resolve(slot.table).catch(() => null));
    const address = (await tables.get(id))?.[slot.index];
    if (!address) throw new RelayMismatchError("A lookup-table account could not be resolved, so nothing was sent");
    loaded.push(address.toBase58());
  }
  return (index: number): Key => {
    if (index < staticKeys.length) return { label: staticKeys[index]!.toBase58(), isStatic: true };
    const label = loaded[index - staticKeys.length];
    if (!label) throw new RelayMismatchError("Invalid account index in the signed transaction");
    return { label, isStatic: false };
  };
}

function instructions(transaction: VersionedTransaction, key: (index: number) => Key): Ix[] {
  return transaction.message.compiledInstructions.map((ix) => ({
    program: key(ix.programIdIndex),
    data: Buffer.from(ix.data).toString("base64"),
    accounts: ix.accountKeyIndexes.map((index) => key(index).label),
  }));
}

const sameIx = (a: Ix, b: Ix) => a.program.label === b.program.label && a.data === b.data
  && a.accounts.length === b.accounts.length && a.accounts.every((account, index) => account === b.accounts[index]);

export async function assertStrictRelayMatch(prepared: VersionedTransaction, signed: VersionedTransaction, resolve: ResolveLookupTable) {
  if (prepared.version !== signed.version) throw new RelayMismatchError("Wallet changed the transaction version, so nothing was sent");
  const mode = sameLookups(prepared.message.addressTableLookups, signed.message.addressTableLookups) ? "slots" : "addresses";
  const tables = new Map<string, Promise<readonly PublicKey[] | null>>();
  const core = instructions(prepared, await keyResolver(prepared, mode, resolve, tables))
    .filter((ix) => isRequiredPreparedProgram(ix.program.label, ix.program.isStatic));
  const returned = instructions(signed, await keyResolver(signed, mode, resolve, tables));
  const { matched, firstDisallowedIndex } = walkWalletReturnedInstructions(core, returned, sameIx,
    (ix) => isAllowedWalletExtraProgram(ix.program.label, ix.program.isStatic));
  if (matched !== core.length) throw new RelayMismatchError("Wallet removed or changed a required instruction, so nothing was sent");
  if (firstDisallowedIndex !== null) {
    const program = returned[firstDisallowedIndex]!.program;
    throw new RelayMismatchError(`Wallet added or changed an instruction (program ${program.isStatic ? program.label : "from a lookup table"}), so nothing was sent`);
  }
}

/** RPC-backed resolver; a missing or unreadable table resolves to null (refused, never skipped). */
export function rpcLookupResolver(connection: { getAddressLookupTable: (key: PublicKey) => Promise<{ value: { state: { addresses: PublicKey[] } } | null }> }): ResolveLookupTable {
  return async (table) => (await connection.getAddressLookupTable(table)).value?.state.addresses ?? null;
}
