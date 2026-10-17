import "@/lib/engine-host";
import "server-only";

import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection, type ParsedAccountData, type ParsedTransactionWithMeta } from "@solana/web3.js";
import { importVerifiedCompoundReceipt } from "@sofinance/engine/compound-recovery-import";
import type { CompoundReceipt } from "@sofinance/engine/compound-attempt";
import { compoundProtocolInstructions } from "@sofinance/engine/swap/receipt";

// Pages bound RPC work, including the importer's recursive prior-yield proof.
export const CLEANUP_SCAN_ACCOUNTS = 8;
export const CLEANUP_SCAN_HISTORY = 6;
const MAX_HISTORY_READS = 48;
type Cursor = { after: string | null; account?: string; before?: string };
type Candidate = { address: string; mint: string; program: string };
export type CleanupDiscovery = {
  wallet: string; receipts: CompoundReceipt[]; nextCursor: string | null;
  scanned: number; totalCandidates: number; incomplete: boolean; errors: number;
};

function parseCursor(value: unknown): Cursor {
  if (value === undefined || value === null) return { after: null };
  if (typeof value !== "string" || value.length > 512) throw new Error("Invalid cleanup scan cursor");
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor) ||
      cursor.after !== null && new PublicKey(cursor.after).toBase58() !== cursor.after ||
      cursor.account !== undefined && new PublicKey(cursor.account).toBase58() !== cursor.account ||
      cursor.before !== undefined && (typeof cursor.before !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(cursor.before)) ||
      (cursor.account === undefined) !== (cursor.before === undefined)) throw new Error();
    return cursor;
  } catch { throw new Error("Invalid cleanup scan cursor"); }
}
const encodeCursor = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString("base64url");

/** Discover only chain-proven compound sources; arbitrary wallet assets are excluded. */
export async function discoverCompoundCleanup(connection: Connection, walletAddress: string, rawCursor?: unknown,
  signal?: AbortSignal): Promise<CleanupDiscovery> {
  const wallet = new PublicKey(walletAddress);
  const cursor = parseCursor(rawCursor);
  signal?.throwIfAborted();
  const inventories = await Promise.all([TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].map(program =>
    connection.getParsedTokenAccountsByOwner(wallet, { programId: program }, "finalized")));
  const candidates: Candidate[] = inventories.flatMap(inventory => inventory.value.flatMap(row => {
    const parsed = (row.account.data as ParsedAccountData).parsed;
    const info = parsed?.info as { mint?: string; owner?: string } | undefined;
    if (parsed?.type !== "account" || info?.owner !== walletAddress || !info.mint) return [];
    const program = row.account.owner;
    if (![TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID].some(id => id.equals(program))) return [];
    const ata = getAssociatedTokenAddressSync(new PublicKey(info.mint), wallet, false, program);
    return ata.equals(row.pubkey) ? [] : [{ address: row.pubkey.toBase58(), mint: info.mint, program: program.toBase58() }];
  })).sort((a, b) => a.address < b.address ? -1 : a.address > b.address ? 1 : 0);
  const live = new Map(candidates.map(account => [account.address, account]));
  const receipts = new Map<string, CompoundReceipt>();
  const transactions = new Map<string, Promise<ParsedTransactionWithMeta | null>>();
  let reads = 0;
  // The verified importer can walk prior yield history. Include that work in
  // this page's budget instead of allowing a fresh budget for every candidate.
  const limited = new Proxy(connection, {
    get(target, property) {
      if (property === "getSignaturesForAddress" || property === "getParsedTransaction") {
        return async (...args: unknown[]) => {
          signal?.throwIfAborted();
          if (++reads > MAX_HISTORY_READS) throw new Error("Cleanup scan read budget reached");
          const result = await Reflect.apply(target[property], target, args);
          signal?.throwIfAborted();
          return result;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const readTransaction = (signature: string) => {
    if (!transactions.has(signature)) transactions.set(signature, limited.getParsedTransaction(signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 }));
    return transactions.get(signature)!;
  };
  const verified = new Set<string>();
  let scanned = 0;
  let after = cursor.after;
  const remaining = candidates.filter(candidate => cursor.account
    ? candidate.address >= cursor.account : !cursor.after || candidate.address > cursor.after);
  for (const candidate of remaining.slice(0, CLEANUP_SCAN_ACCOUNTS)) {
    const retry: Cursor = candidate.address === cursor.account ? cursor : { after };
    try {
      signal?.throwIfAborted();
      if (!verified.has(candidate.address)) {
        const history = await limited.getSignaturesForAddress(new PublicKey(candidate.address),
          { limit: CLEANUP_SCAN_HISTORY, ...(candidate.address === cursor.account ? { before: cursor.before } : {}) }, "finalized");
        let found = false;
        for (const entry of history) {
          if (entry.err) continue;
          const transaction = await readTransaction(entry.signature);
          if (!transaction?.meta || transaction.transaction.signatures[0] !== entry.signature) {
            throw new Error("Finalized cleanup history is temporarily unavailable");
          }
          // A candidate's creation is the only transaction eligible to prove
          // provenance. Other deposits/transfers never become cleanup receipts.
          const createdHere = transaction.transaction.message.instructions.some(instruction =>
            "parsed" in instruction && instruction.programId.equals(PublicKey.default) &&
            instruction.parsed.type === "createAccountWithSeed" && instruction.parsed.info?.newAccount === candidate.address);
          if (!createdHere) continue;
          // Other apps also use seeded token accounts. Their creation does
          // not contain the harvest + reinvest pair required for a compound.
          if (compoundProtocolInstructions(transaction).length < 2) break;
          let receipt: CompoundReceipt;
          try { receipt = await importVerifiedCompoundReceipt(limited, transaction, walletAddress, entry.signature); }
          catch {
            // A seeded account can belong to another application. A failed
            // proof is excluded and reported, never treated as safe to close.
            return { wallet: walletAddress, receipts: [...receipts.values()], scanned, totalCandidates: candidates.length,
              nextCursor: encodeCursor(retry), incomplete: true, errors: 1 };
          }
          const source = receipt.compoundAccounts.find(account => account.address === candidate.address);
          if (receipt.wallet !== walletAddress || receipt.sourceSignature !== entry.signature || !source ||
            source.mint !== candidate.mint || source.program !== candidate.program) throw new Error("Cleanup source proof mismatch");
          if (receipt.compoundAccounts.some(account => {
            const current = live.get(account.address);
            return current && (current.mint !== account.mint || current.program !== account.program);
          })) throw new Error("Cleanup source inventory changed");
          receipts.set(receipt.sourceSignature, receipt);
          receipt.compoundAccounts.forEach(account => verified.add(account.address));
          found = true;
          break;
        }
        if (!found && history.length === CLEANUP_SCAN_HISTORY) {
          // Continue this account's older history without skipping signatures.
          return { wallet: walletAddress, receipts: [...receipts.values()], scanned,
            totalCandidates: candidates.length, nextCursor: encodeCursor({ after, account: candidate.address, before: history.at(-1)!.signature }),
            incomplete: false, errors: 0 };
        }
      }
      scanned++;
      after = candidate.address;
    } catch {
      return { wallet: walletAddress, receipts: [...receipts.values()], scanned, totalCandidates: candidates.length,
        nextCursor: encodeCursor(retry), incomplete: true, errors: 1 };
    }
  }
  return { wallet: walletAddress, receipts: [...receipts.values()], scanned, totalCandidates: candidates.length,
    nextCursor: remaining.length > CLEANUP_SCAN_ACCOUNTS ? encodeCursor({ after }) : null, incomplete: false, errors: 0 };
}
