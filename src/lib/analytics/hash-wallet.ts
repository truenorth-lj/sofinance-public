/** SHA-256 hex of a wallet address. Used as a PostHog distinct id, never the raw address. */
export async function hashWallet(wallet: string): Promise<string> {
  const bytes = new TextEncoder().encode(wallet);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
