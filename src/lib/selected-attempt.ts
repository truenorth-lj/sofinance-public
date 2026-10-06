import bs58 from "bs58";
import { PublicKey } from "@solana/web3.js";
import type { PositionSelection } from "./selected-state";

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
