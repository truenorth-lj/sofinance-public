import "@/lib/engine-host";
import "server-only";

import { unpackMint } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import { mintBlockReasons, poolMintIssues, type MintBlockReason } from "@sofinance/engine/token-safety";

const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** True when an SPL / Token-2022 mint still has a freeze authority (COption tag at byte 46 of the base layout). */
export function mintDataHasFreezeAuthority(data: Uint8Array): boolean {
  if (data.length < 82) throw new Error("Not a token mint account");
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(46, true);
  if (tag !== 0 && tag !== 1) throw new Error("Malformed mint freeze authority");
  return tag === 1;
}

/** On-chain facts of one mint the RWA scan uses: freeze authority (shown as risk only) and block reasons. */
const MAX_KEYS_PER_CALL = 100;

export type MintSafety = {
  freezeAuthority: boolean;
  blockReasons: MintBlockReason[];
  /** Mint settings the open path does not handle yet (the engine's `poolMintIssues`, its `unsupportedExtensions`). */
  unsupported?: string[];
};

/**
 * Freeze authority, Token-2022 block reasons (paused / transfer fee / default-frozen) and unsupported settings of each
 * mint, read from
 * chain in one batched call (read-only). A mint that is missing, not owned by a token program or malformed is left
 * out, so callers can fall back to their API-reported value (and treat it as not blocked).
 */
export async function readMintSafety(connection: Connection, mints: readonly string[]): Promise<Map<string, MintSafety>> {
  const unique = [...new Set(mints)];
  const result = new Map<string, MintSafety>();
  if (unique.length === 0) return result;
  // getMultipleAccounts takes at most 100 keys per call.
  const infos: Awaited<ReturnType<Connection["getMultipleAccountsInfo"]>> = [];
  for (let start = 0; start < unique.length; start += MAX_KEYS_PER_CALL)
    infos.push(...await connection.getMultipleAccountsInfo(unique.slice(start, start + MAX_KEYS_PER_CALL).map((mint) => new PublicKey(mint)), "confirmed"));
  infos.forEach((info, index) => {
    if (!info || !TOKEN_PROGRAMS.has(info.owner.toBase58())) return;
    let freezeAuthority: boolean;
    try { freezeAuthority = mintDataHasFreezeAuthority(info.data); } catch { return; /* left out */ }
    let blockReasons: MintBlockReason[] = [], unsupported: string[] = [];
    try {
      const mint = unpackMint(new PublicKey(unique[index]!), info, info.owner);
      blockReasons = mintBlockReasons(mint);
      unsupported = poolMintIssues(mint);
    } catch { /* base layout only */ }
    result.set(unique[index]!, { freezeAuthority, blockReasons, unsupported });
  });
  return result;
}

/** Freeze authority of each mint (see `readMintSafety`; same single batched read). */
export async function readMintFreezeAuthorities(connection: Connection, mints: readonly string[]): Promise<Map<string, boolean>> {
  const safety = await readMintSafety(connection, mints);
  return new Map([...safety].map(([mint, value]) => [mint, value.freezeAuthority]));
}
