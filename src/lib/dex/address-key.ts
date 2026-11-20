export type AddressChain = "solana" | "robinhood";

/** Address identity for pool lists, icon keys and market-data URLs; never use this to validate or rewrite a transaction address. */
export function chainAddressKey(chain: AddressChain, address: string): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
}

/** Compare pool or token identities on the same chain. */
export function sameChainAddress(chain: AddressChain, a: string, b: string): boolean {
  return chainAddressKey(chain, a) === chainAddressKey(chain, b);
}
