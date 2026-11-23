import bs58 from "bs58";

/** True for a base58 string that decodes to the 64 bytes of a Solana transaction signature. */
export function isSolanaSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 64 || value.length > 88) return false;
  try { return bs58.decode(value).length === 64; } catch { return false; }
}
