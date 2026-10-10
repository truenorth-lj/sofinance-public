/** Base58 Solana address, same shape the pool-daily-apr route accepts. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function parseSolanaAddress(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  return SOLANA_ADDRESS.test(value) ? value : undefined;
}

/** Display label such as `SPCXx/SPCX`. Rejects empty, oversized, or address-shaped values. */
export function parsePairLabel(raw: string | null | undefined): string | undefined {
  const value = raw?.trim() ?? "";
  if (!value || value.length > 32 || SOLANA_ADDRESS.test(value)) return undefined;
  return value;
}

export function pairLabelFromSymbols(wrapped: string, plain: string): string {
  return `${wrapped}/${plain}`;
}
