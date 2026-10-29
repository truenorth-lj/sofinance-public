These fixtures replay real Jupiter swap instructions plus a Raydium Token-2022
open-position instruction captured during local mainnet simulation on 2026-10-10.
`open-size-route.json` reproduces the original 1,524-byte transaction.
`open-size-compact-route.json` captures the smaller sequential fallback.
`open-rent-token22-mainnet.json` records account keys, spaces, and lamport
deltas from a landed Token-2022 open (sig SynthTest… on pool DUzBLHZ5…).

Wallet, wallet ATAs, NFT mint and blockhash are replaced with deterministic test
values. No private keys, API credentials, permits or signatures are recorded.
Lookup table entries unused by these instructions are omitted; tests reconstruct
them as the default public key while preserving the original indexes and length.
Fixtures lock down size, account roles, instruction order and retry behavior;
live simulation separately verifies the actual routes and resulting balances.

`position-open-truncated.json` replays a minimized successful Token-2022
opening receipt with truncated logs. It retains the preceding swap and opening
instructions with their token transfers; parent indexes are remapped after
unrelated instructions are removed. Wallets, mints, pools, token accounts and
the signature are replaced with deterministic test values. It verifies that
deposits come from the opening receipt rather than swap transfers or instruction
amount limits.

`position-liquidity-history-replay.json` contains 50 minimized successful RPC
receipts for additions, withdrawals and fee collection. Position, pool, mint,
wallet and token-account identifiers are replaced with deterministic test keys;
signatures, blockhashes and account balances are omitted. Runtime invocation
lines, scoped calculation events, final liquidity events and transfer receipts
are retained. The differential replay removes each final event and verifies
that recovered cashflows exactly match the original event, including zero-fee
collection and reward-vault transfers.

`orca-whirlpool-accounts-cbbtc-wbtc.json` is a read-only `getMultipleAccounts`
capture (mainnet, one slot, 2026-10-29) of the Orca cbBTC/WBTC Whirlpool
`4v8ufj8H…`, its two mints and the eight tick arrays covering ticks −352…351.
Public program state only; no wallets, signatures or credentials.

`orca-positions-cbbtc-wbtc.json` is a read-only `getMultipleAccounts` capture
(mainnet, slot 462766205, 2026-10-29) of the same Whirlpool, three existing
positions on it (one in range, one above, one below) and the two tick arrays
holding their boundary ticks. Public program state only; the position owners
are not part of these accounts and no signatures or credentials are recorded.

`univ4-rhc-spcx-live.json` is a read-only capture (Robinhood Chain 4663, block
100701103, 2026-10-29) of the allowlisted Uniswap v4 SPCX/SPCXon pool on the
StablePairHook: StateView slot0 / liquidity, the hook's dynamic fee and fee
config, the ERC1967 implementation slot, token metadata, and the decoded
Swap / ModifyLiquidity / Upgraded history since pool init. Public contract
state and events only; no wallets, signatures or credentials.
`test-support/rhc-mock-rpc.ts` replays it as a mock JSON-RPC.

`univ4-rhc-spcx-dexscreener.json` and `univ4-rhc-spcx-geckoterminal.json` are the
public DexScreener (`/latest/dex/pairs/robinhood/{poolId}`) and GeckoTerminal
(`/api/v2/networks/robinhood/pools/{poolId}`) responses for the same pool, captured
2026-10-29 15:14 UTC+8. Public market data only (24h volume, TVL, swap counts);
no wallets, signatures or credentials.
