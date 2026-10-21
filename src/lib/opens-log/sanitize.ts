const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const TX_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,128}$/;
const REF = /^[\w.:-]+$/;
const SYMBOL = /^[\w.+-]{1,24}$/;

export function sanitizeSourceRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 64 || !REF.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeSymbol(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!SYMBOL.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeAddress(value: unknown): string | null {
  return typeof value === "string" && BASE58_ADDRESS.test(value) ? value : null;
}

export function sanitizeTxSignature(value: unknown): string | null {
  return typeof value === "string" && TX_SIGNATURE.test(value) ? value : null;
}
