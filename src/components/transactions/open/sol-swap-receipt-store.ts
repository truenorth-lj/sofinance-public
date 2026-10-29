"use client";
// Durable record of a landed step 1/2 (SOL -> pool token swap) whose step 2/2
// open has not confirmed yet. It lives in localStorage keyed by wallet + pool so
// it survives form edits, closing the modal and a page reload; without it the
// user would hold the swapped tokens but could only open them as a plain token
// deposit (charged the 10 bps token fee again).
import type { SolSwapReceipt } from "./sol-swap-step-client";

/** Mirrors the server's SOL_SWAP_FEE_CREDIT_MS: a step-2 open may skip the already paid fee for 30 minutes. */
export const SOL_SWAP_RECEIPT_TTL_MS = 30 * 60_000;

export type PendingSolSwapReceipt = SolSwapReceipt & {
  /** Browser clock when step 1/2 was observed confirmed. */
  landedAt: number;
  /** Signature of the step 2/2 open sent with this receipt, if any; its confirmation consumes the receipt. */
  openSignature?: string;
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "sofinance:sol-swap-receipt:v1:";
export const solSwapReceiptKey = (wallet: string, poolId: string) => `${PREFIX}${wallet}:${poolId}`;

export function isSolSwapReceiptExpired(receipt: Pick<PendingSolSwapReceipt, "landedAt">, now: number) {
  return now - receipt.landedAt >= SOL_SWAP_RECEIPT_TTL_MS;
}

function parse(value: unknown, wallet: string, poolId: string): PendingSolSwapReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Partial<PendingSolSwapReceipt>;
  if (r.wallet !== wallet || r.poolId !== poolId || typeof r.signature !== "string" || !r.signature ||
    typeof r.outputMint !== "string" || !r.outputMint || (r.outputSymbol !== null && typeof r.outputSymbol !== "string") ||
    typeof r.delivered !== "string" || !/^\d{1,40}$/.test(r.delivered) || BigInt(r.delivered) <= 0n ||
    !Number.isSafeInteger(r.decimals) || r.decimals! < 0 || r.decimals! > 18 ||
    !Number.isSafeInteger(r.landedAt) || r.landedAt! <= 0 ||
    (r.openSignature !== undefined && typeof r.openSignature !== "string")) return null;
  return {
    wallet, poolId, signature: r.signature, outputMint: r.outputMint, outputSymbol: r.outputSymbol ?? null,
    delivered: r.delivered, decimals: r.decimals!, landedAt: r.landedAt!,
    ...(r.openSignature ? { openSignature: r.openSignature } : {}),
  };
}

/** The pending receipt for this wallet + pool, or null. Expired or malformed records are removed. */
export function loadSolSwapReceipt(storage: StorageLike, wallet: string, poolId: string, now: number): PendingSolSwapReceipt | null {
  const key = solSwapReceiptKey(wallet, poolId);
  try {
    const saved = storage.getItem(key);
    if (saved === null) return null;
    const receipt = parse(JSON.parse(saved), wallet, poolId);
    if (!receipt || isSolSwapReceiptExpired(receipt, now)) {
      storage.removeItem(key);
      return null;
    }
    return receipt;
  } catch {
    try { storage.removeItem(key); } catch { /* storage unavailable */ }
    return null;
  }
}

export function saveSolSwapReceipt(storage: StorageLike, receipt: PendingSolSwapReceipt) {
  try { storage.setItem(solSwapReceiptKey(receipt.wallet, receipt.poolId), JSON.stringify(receipt)); } catch { /* storage unavailable: in-memory only */ }
}

export function clearSolSwapReceipt(storage: StorageLike, wallet: string, poolId: string) {
  try { storage.removeItem(solSwapReceiptKey(wallet, poolId)); } catch { /* storage unavailable */ }
}

/** Remove every pending receipt of `wallet` (used when the connected wallet switches away from it). */
export function clearWalletSolSwapReceipts(storage: StorageLike, wallet: string) {
  try {
    const prefix = `${PREFIX}${wallet}:`;
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage.removeItem(key);
  } catch { /* storage unavailable */ }
}

/** window.localStorage, or null where it is unavailable (SSR, privacy mode). */
export function receiptStorage(): StorageLike | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}
