import { type Address, getAddress, isAddress, zeroAddress } from "viem";

/**
 * EVM fee wallet for Robinhood Chain opens (design §3.4 / §10.2). Like the Solana `SOFINANCE_FEE_WALLET`, the address is
 * NOT in the repo: the host reads it from the server-only env var below and passes it in. Fail closed: when it is
 * missing or not an EIP-55 checksummed, non-zero address, no open is built (`fee-wallet-unconfigured`).
 */
export const RHC_FEE_WALLET_ENV = "RHC_UNIV4_FEE_WALLET" as const;

export const FEE_WALLET_UNCONFIGURED_MESSAGE = "Fee wallet not configured; opening is disabled";

/** The checksummed fee wallet, or `null` when unset / blank / not checksummed / the zero address. Never throws. */
export function parseRhcFeeRecipient(raw: string | undefined | null): Address | null {
  const value = raw?.trim();
  if (!value || !isAddress(value, { strict: true })) return null;
  if (value !== getAddress(value)) return null;
  if (value.toLowerCase() === zeroAddress) return null;
  return value as Address;
}
