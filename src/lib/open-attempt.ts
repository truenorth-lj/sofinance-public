import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { OpenPositionSummary } from "./open-types";

export type OpenAttempt = {
  version: 1; wallet: string; signature: string; nftMint: string; positionAccount: string;
  poolId: string; tickLower: number; tickUpper: number; liquidity: string;
  blockhash: string; lastValidBlockHeight: number; createdAt: number;
};
export type OpenAttemptStatus = "pending" | "confirmed" | "failed" | "expired" | "manual-review" | "unsent";
type StorageRead = Pick<Storage, "getItem">;
type StorageWrite = StorageRead & Pick<Storage, "setItem">;
export const openAttemptKey = (wallet: string) => `sofinance:open-position:v1:${wallet}`;

export function openAttemptFromSummary(signature: string, summary: OpenPositionSummary): OpenAttempt {
  return { version: 1, wallet: summary.wallet, signature, nftMint: summary.nftMint, positionAccount: summary.positionAccount,
    poolId: summary.poolId, tickLower: summary.tickLower, tickUpper: summary.tickUpper, liquidity: summary.quote.liquidity,
    blockhash: summary.blockhash, lastValidBlockHeight: summary.lastValidBlockHeight, createdAt: Date.now() };
}

function publicKey(value: unknown): value is string {
  try { return typeof value === "string" && new PublicKey(value).toBase58() === value; } catch { return false; }
}
export function parseOpenAttempt(value: unknown, wallet: string): OpenAttempt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Partial<OpenAttempt>;
  if (record.version !== 1 || record.wallet !== wallet || !publicKey(wallet) ||
    !publicKey(record.nftMint) || !publicKey(record.positionAccount) || !publicKey(record.poolId) ||
    !publicKey(record.blockhash) || typeof record.signature !== "string" ||
    typeof record.liquidity !== "string" || !/^\d{1,40}$/.test(record.liquidity) || BigInt(record.liquidity) <= 0n ||
    !Number.isSafeInteger(record.tickLower) || !Number.isSafeInteger(record.tickUpper) ||
    record.tickLower! >= record.tickUpper! || !Number.isSafeInteger(record.lastValidBlockHeight) ||
    record.lastValidBlockHeight! <= 0 || !Number.isSafeInteger(record.createdAt) || record.createdAt! <= 0) return null;
  try { if (bs58.decode(record.signature).length !== 64) return null; } catch { return null; }
  return record as OpenAttempt;
}
export function loadOpenAttempt(storage: StorageRead, wallet: string) {
  const saved = storage.getItem(openAttemptKey(wallet));
  if (saved === null) return { attempt: null, invalid: false };
  try {
    const attempt = parseOpenAttempt(JSON.parse(saved), wallet);
    return { attempt, invalid: attempt === null };
  } catch { return { attempt: null, invalid: true }; }
}
export function persistOpenAttempt(storage: StorageWrite, attempt: OpenAttempt) {
  if (!parseOpenAttempt(attempt, attempt.wallet)) throw new Error("Invalid open-position transaction record");
  const key = openAttemptKey(attempt.wallet);
  const previous = storage.getItem(key);
  const serialized = JSON.stringify(attempt);
  if (previous !== null && previous !== serialized) {
    let archive = `${key}:history:${loadOpenAttempt(storage, attempt.wallet).attempt?.signature ?? attempt.createdAt}`;
    const prefix = archive;
    for (let index = 1; storage.getItem(archive) !== null && storage.getItem(archive) !== previous; index++) archive = `${prefix}:${index}`;
    storage.setItem(archive, previous);
    if (storage.getItem(archive) !== previous) throw new Error("Unable to preserve open-position history; transaction not broadcast");
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("Unable to save open-position signature; transaction not broadcast");
}

/** A definitive preflight rejection may release the lock, but never erase its signature. */
export function abandonUnsentOpenAttempt(storage: StorageWrite & Pick<Storage, "removeItem">, attempt: OpenAttempt) {
  const key = openAttemptKey(attempt.wallet);
  const saved = loadOpenAttempt(storage, attempt.wallet);
  if (saved.invalid) throw new Error("Open-position history needs verification");
  if (saved.attempt?.signature !== attempt.signature) return;
  const raw = storage.getItem(key)!;
  const archive = `${key}:unsent:${attempt.signature}`;
  storage.setItem(archive, raw);
  if (storage.getItem(archive) !== raw) throw new Error("Unable to preserve unsent open-position record");
  storage.removeItem(key);
  if (storage.getItem(key) !== null) throw new Error("Unable to clear unsent open-position record");
}
