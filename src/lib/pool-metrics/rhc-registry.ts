import type { Address, Hex } from "viem";
import { MULTICALL3_ADDRESS, ROBINHOOD_PUBLIC_RPC_URL } from "@sofinance/engine/chains/robinhood";
import registryFile from "./rhc-tokens.json";
import { sameAssetPairs, type RegistryPair, type RegistryToken } from "./token-registry";

/**
 * Robinhood Chain (4663) side of the token registry: Robinhood stock tokens and Ondo GM tokens. Both
 * issuers deploy every token as an EIP-1967 BeaconProxy of one issuer beacon, so the beacon slot is the
 * issuer's on-chain signature (a same-ticker token on another beacon is not that issuer's token).
 *
 * `rhc-tokens.json` is generated offline by `scripts/rhc-token-registry.ts` (Robinhood asset registry +
 * Ondo factory events + beacon check) and committed by hand; the cron only reads it.
 */
export const RHC_PUBLIC_RPC = ROBINHOOD_PUBLIC_RPC_URL;
export const RHC_MULTICALL3: Address = MULTICALL3_ADDRESS;
/** EIP-1967 beacon slot: bytes32(uint256(keccak256("eip1967.proxy.beacon")) - 1). */
export const RHC_BEACON_SLOT: Hex = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
export const RHC_ISSUER_BEACONS = Object.freeze({
  robinhood: "0xe10b6f6B275de231345c20D14Ab812db62151b00",
  ondo: "0xC6fBC077d53d01f73e3195B2b916fD95555bA222",
} as const satisfies Record<string, Address>);
export type RhcIssuer = keyof typeof RHC_ISSUER_BEACONS;

export type RhcRegistryToken = RegistryToken & {
  chain: "robinhood";
  address: Address;
  issuer: RhcIssuer;
  decimals: number;
  verification: { method: "issuer-beacon"; beacon: Address };
};

export type RhcRegistryFile = {
  chainId: 4663;
  /** Issuer beacon and its implementation when the file was generated (the cron re-checks it). */
  beacons: Record<RhcIssuer, { address: Address; implementation: Address }>;
  /** Ondo tickers with no Robinhood token yet (no pair possible). */
  unpairedOndo: string[];
  tokens: RhcRegistryToken[];
};

export const RHC_REGISTRY = registryFile as RhcRegistryFile;

/** Robinhood / Ondo token pairs of one underlying, from the checked-in registry. */
export function rhcRegistryPairs(file: RhcRegistryFile = RHC_REGISTRY): RegistryPair<RhcRegistryToken>[] {
  return sameAssetPairs(file.tokens);
}
