/**
 * Pending Meteora open, saved in localStorage (public keys and signatures only, never a secret) so retry 2/2 and
 * close-and-refund keep working after a reload. Same-tab writes notify subscribers through a custom event.
 */
export const METEORA_PENDING_KEY = "sofinance:meteora-pending-position:v1";
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

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const STAGES: MeteoraPendingStage[] = ["setup_submitted", "setup_confirmed", "deposit_submitted", "close_submitted"];

export function parseMeteoraPending(raw: string | null): MeteoraPending | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<MeteoraPending>;
    if (!value || typeof value !== "object") return null;
    if (![value.wallet, value.poolId, value.position, value.inputMint].every((v) => typeof v === "string" && BASE58.test(v))) return null;
    if (!Number.isInteger(value.lowerBinId) || !Number.isInteger(value.upperBinId) || typeof value.amount !== "string" || !/^\d+$/.test(value.amount)) return null;
    if (!STAGES.includes(value.stage as MeteoraPendingStage)) return null;
    for (const key of ["setupSignature", "depositSignature", "closeSignature"] as const) {
      if (value[key] !== undefined && !(typeof value[key] === "string" && BASE58.test(value[key]!))) return null;
    }
    return value as MeteoraPending;
  } catch {
    return null;
  }
}

export function readMeteoraPendingRaw(): string | null {
  try { return window.localStorage.getItem(METEORA_PENDING_KEY); } catch { return null; }
}

export function writeMeteoraPending(value: MeteoraPending | null) {
  try {
    if (value) window.localStorage.setItem(METEORA_PENDING_KEY, JSON.stringify(value));
    else window.localStorage.removeItem(METEORA_PENDING_KEY);
  } catch { /* storage unavailable: the flow still works until reload */ }
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeMeteoraPending(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => { window.removeEventListener("storage", onChange); window.removeEventListener(EVENT, onChange); };
}
