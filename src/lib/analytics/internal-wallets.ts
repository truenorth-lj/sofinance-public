/**
 * Team and friends wallets. Events from these carry `is_internal: true` so
 * growth counts (e.g. the first-30-external-wallets goal) can filter them out.
 * Single source of truth — add or remove wallets here only.
 */
export const INTERNAL_WALLETS: readonly string[] = [
  "EweTgJ6vaQDZyH5nk5uaK5iD7n1qr7BXTaxewcjQNEjb", // shared test wallet
  "3SBfuWVR9cRLaGrHof9eLESeVQcDkUfLf9TRf3nwQTNv",
  "tRxmfW5wvk99jgdXgfmnq27nG4XJUNoGurjfwnWrmQa",
  "4mLbqtJX1sPX7UbuitE2JGwhTniqjX3LNKTyBbEsUUK7",
  "DHkoA4NmNnzSeUGoc93QHd3jcZTry1GQBWMhfwZVJGmM",
];

const INTERNAL = new Set(INTERNAL_WALLETS);

export function isInternalWallet(wallet: string | null | undefined): boolean {
  return Boolean(wallet) && INTERNAL.has(wallet!);
}

export type WalletEventProperties = { wallet_address?: string; is_internal: boolean };

/** Public wallet address + internal flag. No other identifying data. */
export function walletEventProperties(wallet: string | null | undefined): WalletEventProperties {
  return wallet ? { wallet_address: wallet, is_internal: isInternalWallet(wallet) } : { is_internal: false };
}
