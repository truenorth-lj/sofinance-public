import "@/lib/engine-host";
import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { PositionSelection } from "@sofinance/engine/selected-state";

export type SelectedAttempt = {
  version: 2; wallet: string; selection: PositionSelection; poolId: string; positionAccount: string;
  signature: string; createdAt: number; requested: string; floorBps: number;
  startingBalances: { input: string; a: string; b: string }; startingLiquidity: string;
  expectedLiquidity: string; blockhash: string; lastValidBlockHeight: number;
};

export function selectedAttemptKey(wallet: string) {
  return `sofinance:selected-atomic:v2:${wallet}`;
}

function validKey(value: unknown) {
  if (typeof value !== "string") return false;
  try { return new PublicKey(value).toBase58() === value; } catch { return false; }
}

export function parseSelectedAttempt(value: unknown, wallet: string): SelectedAttempt | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<SelectedAttempt>;
  const raw = (item: unknown) => typeof item === "string" && /^\d+$/.test(item);
  if (record.version !== 2 || record.wallet !== wallet || !record.selection ||
    !validKey(record.selection.positionMint) || !validKey(record.selection.inputMint) ||
    (record.selection.inputKind !== "native" && record.selection.inputKind !== "token") ||
    !validKey(record.poolId) || !validKey(record.positionAccount) ||
    typeof record.signature !== "string" || !Number.isSafeInteger(record.createdAt) ||
    !raw(record.requested) || !raw(record.startingLiquidity) || !raw(record.expectedLiquidity) ||
    !record.startingBalances || !raw(record.startingBalances.input) ||
    !raw(record.startingBalances.a) || !raw(record.startingBalances.b) ||
    typeof record.blockhash !== "string" || !record.blockhash ||
    !Number.isSafeInteger(record.lastValidBlockHeight) ||
    !Number.isSafeInteger(record.floorBps) || record.floorBps! < 9_500 ||
    record.floorBps! > 10_000 || record.floorBps! % 10 !== 0) return null;
  try { if (bs58.decode(record.signature).length !== 64) return null; }
  catch { return null; }
  return record as SelectedAttempt;
}

export function loadSelectedAttempt(storage: Pick<Storage, "getItem">, wallet: string) {
  const saved = storage.getItem(selectedAttemptKey(wallet));
  if (saved === null) return { attempt: null, invalid: false };
  try {
    const attempt = parseSelectedAttempt(JSON.parse(saved), wallet);
    return { attempt, invalid: attempt === null };
  } catch { return { attempt: null, invalid: true }; }
}

/** Preserve the previous receipt before replacing the current signed attempt. */
export function persistSelectedAttempt(storage: Pick<Storage, "getItem" | "setItem" | "length">, attempt: SelectedAttempt) {
  const key = selectedAttemptKey(attempt.wallet);
  const previous = storage.getItem(key);
  const serialized = JSON.stringify(attempt);
  if (previous !== null && previous !== serialized) {
    const saved = loadSelectedAttempt(storage, attempt.wallet);
    const prefix = `${key}:history:${saved.attempt?.signature ?? `${Date.now()}:${storage.length}`}`;
    let historyKey = prefix;
    for (let index = 1; storage.getItem(historyKey) !== null && storage.getItem(historyKey) !== previous; index++) {
      historyKey = `${prefix}:${index}`;
    }
    storage.setItem(historyKey, previous);
    if (storage.getItem(historyKey) !== previous) throw new Error("Unable to preserve previous transaction record; transaction not broadcast");
  }
  storage.setItem(key, serialized);
  if (storage.getItem(key) !== serialized) throw new Error("Unable to save transaction record; transaction not broadcast");
}

export function readSelectedHistory(storage: Pick<Storage, "getItem" | "key" | "length">, wallet: string) {
  const history: SelectedAttempt[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (!key?.startsWith(`${selectedAttemptKey(wallet)}:history:`)) continue;
    try {
      const record = parseSelectedAttempt(JSON.parse(storage.getItem(key) || "null"), wallet);
      if (record) history.push(record);
    } catch { /* Invalid receipts are retained in storage, never used as transaction input. */ }
  }
  return history;
}
