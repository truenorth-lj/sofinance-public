"use client";

import bs58 from "bs58";
import type { PendingSolSwapReceipt } from "./sol-swap-receipt-store";
import { solSwapReceiptKey } from "./sol-swap-receipt-store";

export type SolSwapStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type SolSwapAttempt = {
  version: 1;
  wallet: string;
  poolId: string;
  signature: string;
  outputMint: string;
  outputSymbol: string | null;
  lastValidBlockHeight: number;
  createdAt: number;
};

export const solSwapAttemptKey = (wallet: string) => `sofinance:sol-swap-attempt:v1:${wallet}`;
const changedEvent = "sofinance:sol-swap-attempt-changed";
export const SOL_SWAP_STORAGE_ERROR = "Unable to verify saved SOL swap history. Restore browser storage and check the original transaction before opening again.";
export class SolSwapStorageError extends Error {
  constructor() { super(SOL_SWAP_STORAGE_ERROR); this.name = "SolSwapStorageError"; }
}

function encodedBytes(value: unknown, size: number) {
  try { return typeof value === "string" && bs58.decode(value).length === size; } catch { return false; }
}

export function parseSolSwapAttempt(raw: string | null, wallet: string): SolSwapAttempt | null {
  if (raw === null) return null;
  try {
    const item = JSON.parse(raw) as SolSwapAttempt;
    if (item?.version !== 1 || item.wallet !== wallet || !encodedBytes(item.wallet, 32) ||
      !encodedBytes(item.poolId, 32) || !encodedBytes(item.outputMint, 32) || !encodedBytes(item.signature, 64) ||
      (item.outputSymbol !== null && typeof item.outputSymbol !== "string") ||
      !Number.isSafeInteger(item.lastValidBlockHeight) || item.lastValidBlockHeight <= 0 ||
      !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0) throw new SolSwapStorageError();
    return item;
  } catch { throw new SolSwapStorageError(); }
}

export function requireSolSwapStorage(): SolSwapStorage {
  try { return window.localStorage; } catch { throw new SolSwapStorageError(); }
}

export function readSolSwapAttempt(storage: SolSwapStorage, wallet: string): SolSwapAttempt | null {
  try { return parseSolSwapAttempt(storage.getItem(solSwapAttemptKey(wallet)), wallet); }
  catch { throw new SolSwapStorageError(); }
}

function notify() { if (typeof window !== "undefined") window.dispatchEvent(new Event(changedEvent)); }
export function subscribeSolSwapAttempt(changed: () => void) {
  window.addEventListener("storage", changed);
  window.addEventListener(changedEvent, changed);
  return () => { window.removeEventListener("storage", changed); window.removeEventListener(changedEvent, changed); };
}

export function persistSolSwapAttempt(storage: SolSwapStorage, attempt: SolSwapAttempt) {
  const raw = JSON.stringify(attempt), key = solSwapAttemptKey(attempt.wallet);
  parseSolSwapAttempt(raw, attempt.wallet);
  try {
    if (storage.getItem(key) !== null) throw new SolSwapStorageError();
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new SolSwapStorageError();
  } catch { throw new SolSwapStorageError(); }
  finally { notify(); }
}

export function assertSolSwapAttempt(storage: SolSwapStorage, attempt: SolSwapAttempt) {
  try {
    if (storage.getItem(solSwapAttemptKey(attempt.wallet)) !== JSON.stringify(attempt)) throw new SolSwapStorageError();
  } catch { throw new SolSwapStorageError(); }
}

export function clearSolSwapAttempt(storage: SolSwapStorage, attempt: SolSwapAttempt) {
  try {
    assertSolSwapAttempt(storage, attempt);
    const key = solSwapAttemptKey(attempt.wallet);
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new SolSwapStorageError();
  } catch { throw new SolSwapStorageError(); }
  finally { notify(); }
}

/** Receipt first, pending removal second: a crash between them keeps enough evidence to requery. */
export function completeSolSwapAttempt(storage: SolSwapStorage, attempt: SolSwapAttempt,
  delivery: { delivered: string; decimals: number }): PendingSolSwapReceipt {
  assertSolSwapAttempt(storage, attempt);
  const receipt: PendingSolSwapReceipt = { wallet: attempt.wallet, poolId: attempt.poolId,
    signature: attempt.signature, outputMint: attempt.outputMint, outputSymbol: attempt.outputSymbol,
    ...delivery, landedAt: Date.now() };
  try {
    const key = solSwapReceiptKey(attempt.wallet, attempt.poolId);
    const previous = storage.getItem(key);
    // Another observer may already have saved/used this delivery. Never erase its openSignature or extend its TTL.
    if (previous !== null) {
      const saved = JSON.parse(previous) as PendingSolSwapReceipt;
      if (saved.wallet !== receipt.wallet || saved.poolId !== receipt.poolId || saved.signature !== receipt.signature ||
        saved.outputMint !== receipt.outputMint || saved.delivered !== receipt.delivered || saved.decimals !== receipt.decimals ||
        (saved.outputSymbol !== null && typeof saved.outputSymbol !== "string") ||
        (saved.openSignature !== undefined && typeof saved.openSignature !== "string") ||
        !Number.isSafeInteger(saved.landedAt) || saved.landedAt <= 0) throw new SolSwapStorageError();
      clearSolSwapAttempt(storage, attempt);
      return saved;
    }
    const raw = JSON.stringify(receipt);
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new SolSwapStorageError();
    clearSolSwapAttempt(storage, attempt);
    return receipt;
  } catch { throw new SolSwapStorageError(); }
}
