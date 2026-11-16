/** Address identity for pool lists, icon keys and market-data URLs; never use this to validate or rewrite a transaction address. */
export function chainAddressKey(chain: "solana" | "robinhood", address: string): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
}
