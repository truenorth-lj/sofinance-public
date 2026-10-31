import type { TxFlow } from "./errors";

/**
 * Stage 4 (saved attempts): one signature-keyed record per sent transaction, so a reload can
 * finish tracking it. Records are removed as soon as the signature settles (confirmed, failed
 * or expired), which is what keeps stale "previous transaction" banners from piling up.
 */
export type TxAttempt = {
  version: 1; flow: TxFlow; wallet: string; signature: string; lastValidBlockHeight: number;
  createdAt: number; successTitle: string; positionMint?: string;
};
type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

export const txAttemptsKey = (wallet: string) => `sofinance:tx-attempts:v1:${wallet}`;
const MAX_ATTEMPTS = 20;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function valid(value: unknown, wallet: string): value is TxAttempt {
  const item = value as Partial<TxAttempt> | null;
  return !!item && item.version === 1 && item.wallet === wallet && typeof item.signature === "string" &&
    /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(item.signature) && Number.isSafeInteger(item.lastValidBlockHeight) &&
    typeof item.createdAt === "number" && typeof item.successTitle === "string" &&
    ["add", "open", "compound", "withdraw", "swap"].includes(item.flow as string);
}

export function loadTxAttempts(storage: Storage, wallet: string, now = Date.now()): TxAttempt[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem(txAttemptsKey(wallet)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => valid(item, wallet) && now - item.createdAt < MAX_AGE_MS) : [];
  } catch { return []; }
}

function write(storage: Storage, wallet: string, attempts: TxAttempt[]) {
  if (!attempts.length) storage.removeItem(txAttemptsKey(wallet));
  else storage.setItem(txAttemptsKey(wallet), JSON.stringify(attempts.slice(-MAX_ATTEMPTS)));
}

export function saveTxAttempt(storage: Storage, attempt: TxAttempt) {
  try {
    write(storage, attempt.wallet, [...loadTxAttempts(storage, attempt.wallet).filter((item) => item.signature !== attempt.signature), attempt]);
  } catch { /* Storage full or blocked: the in-memory notice still tracks this signature. */ }
}

export function clearTxAttempt(storage: Storage, wallet: string, signature: string) {
  try {
    const attempts = loadTxAttempts(storage, wallet);
    if (attempts.some((item) => item.signature === signature)) write(storage, wallet, attempts.filter((item) => item.signature !== signature));
  } catch { /* ignore */ }
}
