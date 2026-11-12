/**
 * Hermetic E3 fixtures: no live API or RPC. The generic adapter lists no positions and every
 * money capability is unsupported, so there is nothing to replay. `setup` / `fetch` are omitted.
 *
 * Owner is the well-known Solana system program id (public, not a user wallet). Used only as
 * the string `listPositions` is called with. `feeWallet` is the same well-known id: the fee
 * policy declares the existing 10 bps rule, but this adapter never builds a transfer, so the
 * contract only needs a valid pubkey. This file must not import the contract harness.
 */
export const raydiumClmmFixtures = {
  owner: "11111111111111111111111111111111",
  expectedPositionKeys: [] as const,
  feeWallet: "11111111111111111111111111111111",
  mintPrograms: {} as const,
};
