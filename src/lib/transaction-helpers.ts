import "server-only";

import { AddressLookupTableAccount, Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { ApiInstruction, BuildRoute } from "./jupiter-route";

export function instruction(value: ApiInstruction, wallet: PublicKey) {
  if (value.accounts.some((account) => account.isSigner && account.pubkey !== wallet.toBase58())) {
    throw new Error("Route contains non-wallet signer");
  }
  return new TransactionInstruction({
    programId: new PublicKey(value.programId),
    keys: value.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey), isSigner: account.isSigner, isWritable: account.isWritable,
    })),
    data: Buffer.from(value.data, "base64"),
  });
}

export async function readLookupTables(connection: Connection, keys: PublicKey[]) {
  const unique = [...new Map(keys.map((key) => [key.toBase58(), key])).values()];
  const results = await Promise.all(unique.map((key) => connection.getAddressLookupTable(key, { commitment: "confirmed" })));
  return results.map((result, index) => {
    const key = unique[index];
    if (!key || !result.value) throw new Error(`Address lookup table does not exist: ${key?.toBase58() || "unknown"}`);
    return result.value;
  });
}

export function validateRouteTables(routes: BuildRoute[], tables: AddressLookupTableAccount[]) {
  const actual = new Map(tables.map((table) => [table.key.toBase58(), table.state.addresses.map((address) => address.toBase58())]));
  for (const route of routes) for (const [key, addresses] of Object.entries(route.addressesByLookupTableAddress || {})) {
    const onChain = actual.get(key);
    if (!onChain || addresses.some((address, index) => onChain[index] !== address)) {
      throw new Error("Jupiter address lookup table does not match on-chain content");
    }
  }
}
