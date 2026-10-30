import bs58 from "bs58";
/**
 * Pending Meteora open, saved in localStorage (public keys and signatures only, never a secret) so retry 2/2 and
 * close-and-refund keep working after a reload. Same-tab writes notify subscribers through a custom event.
 */
export const METEORA_PENDING_KEY = "sofinance:meteora-pending-position:v1";
export const meteoraPendingKey = (wallet: string) => `${METEORA_PENDING_KEY}:${wallet}`;
export const METEORA_HISTORY_ERROR = "Unable to verify saved Meteora transactions. Restore browser storage and check the original transaction before continuing.";
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
const EVENT = "sofinance:meteora-pending";

export type MeteoraPendingStage = "setup_submitted" | "setup_confirmed" | "deposit_submitted" | "close_submitted";

export type MeteoraPending = {
  wallet: string;
  poolId: string;
  position: string;
  lowerBinId: number;
  upperBinId: number;
  inputMint: string;
  amount: string;
  stage: MeteoraPendingStage;
  setupSignature?: string;
  setupLastValidBlockHeight?: number;
  depositSignature?: string;
  depositLastValidBlockHeight?: number;
  closeSignature?: string;
  closeLastValidBlockHeight?: number;
};

const encodedBytes = (value: unknown, length: number) => {
  try { return typeof value === "string" && bs58.decode(value).length === length; } catch { return false; }
};
const STAGES: MeteoraPendingStage[] = ["setup_submitted", "setup_confirmed", "deposit_submitted", "close_submitted"];

export function parseMeteoraPending(raw: string | null): MeteoraPending | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeteoraPending>;
    if (!value || typeof value !== "object") return null;
    if (![value.wallet, value.poolId, value.position, value.inputMint].every((v) => encodedBytes(v, 32))) return null;
    if (!Number.isSafeInteger(value.lowerBinId) || !Number.isSafeInteger(value.upperBinId) || value.lowerBinId! > value.upperBinId! ||
      value.upperBinId! - value.lowerBinId! >= 70 || typeof value.amount !== "string" || !/^\d{1,40}$/.test(value.amount) || BigInt(value.amount) <= 0n) return null;
    if (!STAGES.includes(value.stage as MeteoraPendingStage)) return null;
    for (const key of ["setupSignature", "depositSignature", "closeSignature"] as const) {
      if (value[key] !== undefined && !encodedBytes(value[key], 64)) return null;
    }
    for (const key of ["setupLastValidBlockHeight", "depositLastValidBlockHeight", "closeLastValidBlockHeight"] as const) {
      if (value[key] !== undefined && (!Number.isSafeInteger(value[key]) || value[key]! <= 0)) return null;
    }
    return value as MeteoraPending;
  } catch {
    return null;
  }
}

export function readMeteoraPendingRaw(wallet: string, storage: StorageLike = window.localStorage): string | null {
  const raw = storage.getItem(meteoraPendingKey(wallet));
  const legacy = storage.getItem(METEORA_PENDING_KEY);
  const parsed = parseMeteoraPending(legacy);
  if (raw !== null) {
    if (legacy !== null && (!parsed || parsed.wallet === wallet && legacy !== raw)) throw new Error(METEORA_HISTORY_ERROR);
    return raw;
  }
  // Invalid legacy data has unknown ownership: preserve it and fail closed for new opens.
  return legacy !== null && (!parsed || parsed.wallet === wallet) ? legacy : null;
}

export function assertMeteoraPending(wallet: string, expected: MeteoraPending | null, storage: StorageLike = window.localStorage) {
  try {
    if (readMeteoraPendingRaw(wallet, storage) !== (expected ? JSON.stringify(expected) : null)) throw new Error();
  } catch { throw new Error(METEORA_HISTORY_ERROR); }
}

/** Compare/write/readback, then remove only this wallet's legacy record. No clock expiry. */
export function writeMeteoraPending(wallet: string, value: MeteoraPending | null, expected: MeteoraPending | null,
  storage: StorageLike = window.localStorage) {
  try {
    assertMeteoraPending(wallet, expected, storage);
    if (value && (value.wallet !== wallet || !parseMeteoraPending(JSON.stringify(value)))) throw new Error();
    if (value && value.stage !== "setup_confirmed") {
      const kind = value.stage === "setup_submitted" ? "setup" : value.stage === "deposit_submitted" ? "deposit" : "close";
      if (!value[`${kind}Signature`] || !value[`${kind}LastValidBlockHeight`]) throw new Error();
    }
    const key = meteoraPendingKey(wallet);
    if (value) {
      storage.setItem(key, JSON.stringify(value));
      if (storage.getItem(key) !== JSON.stringify(value)) throw new Error();
    }
    const legacy = storage.getItem(METEORA_PENDING_KEY);
    if (legacy !== null && parseMeteoraPending(legacy)?.wallet === wallet) {
      storage.removeItem(METEORA_PENDING_KEY);
      if (storage.getItem(METEORA_PENDING_KEY) !== null) throw new Error();
    }
    if (!value) {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) throw new Error();
    }
  } catch { throw new Error(METEORA_HISTORY_ERROR); }
  finally { if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT)); }
}

export function subscribeMeteoraPending(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener(EVENT, onChange); };
}
