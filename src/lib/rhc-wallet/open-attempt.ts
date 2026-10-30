import { currentChainId, type Eip1193Provider, RHC_CHAIN_ID, RHC_UNKNOWN_SEND } from "./eip1193";
export { RHC_UNKNOWN_SEND } from "./eip1193";
import { mintedPositionId, waitForReceipt } from "./open-execute";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type RhcOpenAttempt = {
  version: 1; id: string; wallet: string; poolId: string; kind: "approve" | "execute";
  hash: string | null; createdAt: number;
};
export const rhcOpenAttemptKey = (wallet: string) => `sofi:rhc:open-attempt:v1:4663:${wallet.toLowerCase()}`;
export const RHC_HISTORY_ERROR = "Unable to verify Robinhood Chain transaction history. Restore browser storage and check your wallet activity before opening again.";
const changedEvent = "sofi:rhc:open-attempt-changed";
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
export const isRhcTxHash = (hash: unknown): hash is string => typeof hash === "string" && hashPattern.test(hash);

export function rhcOpenStorage(): StorageLike {
  try { return window.localStorage; } catch { throw new Error(RHC_HISTORY_ERROR); }
}
export function parseRhcOpenAttempt(raw: string | null, wallet: string): RhcOpenAttempt | null {
  if (raw === null) return null;
  try {
    const a = JSON.parse(raw) as RhcOpenAttempt;
    if (a?.version !== 1 || typeof a.id !== "string" || !a.id || typeof a.wallet !== "string" ||
      !/^0x[0-9a-fA-F]{40}$/.test(a.wallet) || a.wallet.toLowerCase() !== wallet.toLowerCase() ||
      !isRhcTxHash(a.poolId) || (a.kind !== "approve" && a.kind !== "execute") ||
      (a.hash !== null && !isRhcTxHash(a.hash)) || !Number.isSafeInteger(a.createdAt) || a.createdAt <= 0) throw new Error();
    return a;
  } catch { throw new Error(RHC_HISTORY_ERROR); }
}
export function readRhcOpenAttempt(wallet: string, storage = rhcOpenStorage()) {
  try { return parseRhcOpenAttempt(storage.getItem(rhcOpenAttemptKey(wallet)), wallet); }
  catch { throw new Error(RHC_HISTORY_ERROR); }
}
export function subscribeRhcOpenAttempt(changed: () => void) {
  window.addEventListener("storage", changed); window.addEventListener(changedEvent, changed);
  return () => { window.removeEventListener("storage", changed); window.removeEventListener(changedEvent, changed); };
}
export function assertRhcOpenAttempt(attempt: RhcOpenAttempt, storage = rhcOpenStorage()) {
  try { if (storage.getItem(rhcOpenAttemptKey(attempt.wallet)) !== JSON.stringify(attempt)) throw new Error(); }
  catch { throw new Error(RHC_HISTORY_ERROR); }
}
/** Persist intent before asking the wallet to send; its hash is not available until the provider replies. */
export function writeRhcOpenAttempt(attempt: RhcOpenAttempt, previous: RhcOpenAttempt | null, storage = rhcOpenStorage()) {
  parseRhcOpenAttempt(JSON.stringify(attempt), attempt.wallet);
  try {
    if (previous) {
      if (previous.wallet.toLowerCase() !== attempt.wallet.toLowerCase() || previous.id !== attempt.id) throw new Error();
      assertRhcOpenAttempt(previous, storage);
    } else if (storage.getItem(rhcOpenAttemptKey(attempt.wallet)) !== null) throw new Error();
    storage.setItem(rhcOpenAttemptKey(attempt.wallet), JSON.stringify(attempt));
    assertRhcOpenAttempt(attempt, storage);
  } catch { throw new Error(RHC_HISTORY_ERROR); }
  finally { if (typeof window !== "undefined") window.dispatchEvent(new Event(changedEvent)); }
}
export function clearRhcOpenAttempt(attempt: RhcOpenAttempt, storage = rhcOpenStorage()) {
  try {
    assertRhcOpenAttempt(attempt, storage);
    const key = rhcOpenAttemptKey(attempt.wallet);
    storage.removeItem(key);
    if (storage.getItem(key) !== null) throw new Error();
  } catch { throw new Error(RHC_HISTORY_ERROR); }
  finally { if (typeof window !== "undefined") window.dispatchEvent(new Event(changedEvent)); }
}

/** A stalled read cannot hold the recovery UI indefinitely. Its late response has no side effects. */
function boundedReader(provider: Eip1193Provider, timeoutMs: number): Eip1193Provider {
  return { request: args => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Wallet read timed out")), timeoutMs);
    Promise.resolve().then(() => provider.request(args)).then(resolve, reject).finally(() => clearTimeout(timer));
  }) };
}

/** No chain switching, signing or resend. Missing/malformed receipts keep admission blocked. */
export async function reconcileRhcOpenAttempt(attempt: RhcOpenAttempt, provider: Eip1193Provider,
  current: () => boolean, poll?: { intervalMs?: number; timeoutMs?: number }) {
  const check = () => { if (!current()) throw new Error("Wallet or form changed; check the original transaction."); assertRhcOpenAttempt(attempt); };
  check();
  if (!attempt.hash) throw new Error(RHC_UNKNOWN_SEND);
  const reader = boundedReader(provider, Math.max(1, Math.min(poll?.timeoutMs ?? 10_000, 10_000)));
  if (await currentChainId(reader) !== RHC_CHAIN_ID) throw new Error("Switch your wallet to Robinhood Chain to check the original transaction.");
  check();
  const receipt = await waitForReceipt(reader, attempt.hash, poll);
  check();
  if (await currentChainId(reader) !== RHC_CHAIN_ID) throw new Error("Wallet chain changed; check the original transaction on Robinhood Chain.");
  check();
  if (!receipt) return { status: "timeout" as const, positionId: null };
  const hash = (receipt as { transactionHash?: unknown }).transactionHash;
  if (!isRhcTxHash(hash) || hash.toLowerCase() !== attempt.hash.toLowerCase() ||
    (receipt.status !== "0x1" && receipt.status !== "0x0")) throw new Error("Receipt is incomplete. Check the original transaction again; do not resend.");
  const positionId = attempt.kind === "execute" && receipt.status === "0x1" ? mintedPositionId(receipt, attempt.wallet) : null;
  if (attempt.kind === "execute" && receipt.status === "0x1" && positionId === null) {
    throw new Error("The receipt does not confirm the position NFT. Keep the original transaction for review; do not resend.");
  }
  return { status: receipt.status === "0x1" ? "success" as const : "reverted" as const, positionId };
}
