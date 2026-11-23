/**
 * PostHog distinct id for a wallet: `wallet:` + the SHA-256 hex digest of the address string (UTF-8).
 *
 * The website and the MCP server send this one format, never the raw address. sofi-metrics already treats
 * `wallet:<sha256>` and the raw address as the same wallet, so older raw-address events still count once.
 */
const WALLET_ID_PREFIX = "wallet:";

export function walletIdFromSha256Hex(hex: string): string {
  return `${WALLET_ID_PREFIX}${hex}`;
}

/** Browser and server: WebCrypto. The server's sync `walletDistinctId` (node:crypto) gives the same id. */
export async function hashedWalletId(wallet: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(wallet));
  return walletIdFromSha256Hex(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
}
