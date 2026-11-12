/**
 * First 4 and last 4 characters, with an ellipsis. EVM addresses (0x…) keep the 0x and use the next 4 hex digits
 * as the prefix (`0x1234…5678`). Solana and other strings stay first4…last4. Values too short to shorten are shown in full.
 */
export function shortAddress(address: string): string {
  const text = address.trim();
  if (/^0x/i.test(text)) {
    return text.length > 10 ? `${text.slice(0, 6)}…${text.slice(-4)}` : text;
  }
  return text.length > 8 ? `${text.slice(0, 4)}…${text.slice(-4)}` : text;
}
