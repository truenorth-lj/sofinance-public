/**
 * Hermetic E2-register fixtures: no live API or RPC. Money capabilities on the generic adapter
 * are unsupported and this suite stubs the holdings scan to an empty list, so there is nothing
 * to replay. `setup` / `fetch`
 * are omitted; any fetch that reached the offline guard would fail the contract suite.
 *
 * Owner is a fixed dummy EVM address (not a user wallet, not the fee wallet). Used only as the
 * string `listPositions` is called with.
 *
 * `feeWallet` is a dummy address the contract harness requires because `feePolicy.open` charges
 * 10 bps. It is not the production `RHC_UNIV4_FEE_WALLET` (that value is not in the repo). This
 * file must not import the contract harness (architecture-dex: only tests import `__contract__`).
 */
export const uniswapV4RhcFixtures = {
  owner: "0x2222222222222222222222222222222222222222",
  expectedPositionKeys: [] as const,
  feeWallet: "0x00000000000000000000000000000000000fee01",
};
