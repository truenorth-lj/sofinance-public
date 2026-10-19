/**
 * Wallet-connect attestation. Stored in localStorage (per browser, not per wallet): it is a UX gate
 * that records the user's click, not a server-side record. Bump TERMS_VERSION when the Terms change
 * materially to ask again.
 */
export const TERMS_VERSION = "2026-10-19";
export const TERMS_STORAGE_KEY = "sofinance.termsAcceptance";
export const TERMS_PATH = "/terms";
export const TERMS_ATTESTATION =
  "I am not a resident of the United States or Taiwan, am not located in a restricted region, and agree to the Terms of Service";

type StorageLike = Pick<Storage, "getItem" | "setItem">;

const browserStorage = (): StorageLike | null => {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
};

export function hasAcceptedTerms(storage: StorageLike | null = browserStorage()): boolean {
  if (!storage) return false;
  try {
    const parsed = JSON.parse(storage.getItem(TERMS_STORAGE_KEY) || "null") as { version?: unknown } | null;
    return parsed?.version === TERMS_VERSION;
  } catch {
    return false;
  }
}

export function recordTermsAcceptance(storage: StorageLike | null = browserStorage(), now = new Date()): void {
  if (!storage) return;
  try {
    storage.setItem(TERMS_STORAGE_KEY, JSON.stringify({ version: TERMS_VERSION, acceptedAt: now.toISOString(), attestation: TERMS_ATTESTATION }));
  } catch {
    // Private mode / quota: the gate simply asks again next time.
  }
}
