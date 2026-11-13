/**
 * Hermetic E1 fixtures: no live API or RPC. The adapter lists no positions and every money
 * capability is unsupported, so there is nothing to replay. `setup` / `fetch` are omitted;
 * any fetch that reached the offline guard would fail the contract suite.
 *
 * Owner is the well-known Solana system program id (public, not a user wallet). Used only as
 * the string `listPositions` is called with. This file must not import the contract harness
 * (architecture-dex: only tests import `__contract__`).
 */
export const orcaWhirlpoolFixtures = {
  owner: "11111111111111111111111111111111",
  expectedPositionKeys: [] as const,
  /** Required for every Solana DEX. E1 prepares no steps, so no mints are touched. */
  mintPrograms: {} as const,
};
