import "@/lib/engine-host";
import "server-only";

import { PublicKey, type Connection } from "@solana/web3.js";

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** True when an SPL / Token-2022 mint still has a freeze authority (COption tag at byte 46 of the base layout). */
export function mintDataHasFreezeAuthority(data: Uint8Array): boolean {
  if (data.length < 82) throw new Error("Not a token mint account");
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(46, true);
  if (tag !== 0 && tag !== 1) throw new Error("Malformed mint freeze authority");
  return tag === 1;
}

/**
 * Freeze authority of each mint, read from chain in one batched call (read-only). A mint that is missing, not
 * owned by a token program or malformed is left out, so callers can fall back to their API-reported value.
 */
export async function readMintFreezeAuthorities(connection: Connection, mints: readonly string[]): Promise<Map<string, boolean>> {
  const unique = [...new Set(mints)];
  const result = new Map<string, boolean>();
  if (unique.length === 0) return result;
  const infos = await connection.getMultipleAccountsInfo(unique.map((mint) => new PublicKey(mint)), "confirmed");
  infos.forEach((info, index) => {
    if (!info || !TOKEN_PROGRAMS.has(info.owner.toBase58())) return;
    try { result.set(unique[index]!, mintDataHasFreezeAuthority(info.data)); } catch { /* left out */ }
  });
  return result;
}
