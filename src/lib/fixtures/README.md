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

`orca-position-history-cbbtc-wbtc.json` contains 41 minimized successful
mainnet receipts (read-only `getTransaction`, jsonParsed) for the three Orca
cbBTC/WBTC positions in `packages/engine/src/fixtures/orca-positions-cbbtc-wbtc.json`:
opens, increases (v1, v2 and by-token-amounts), decreases and fee collections.
Program, pool, vault, mint, position and position-NFT keys are real public
program state; every other key (wallets, wallet token accounts, tick arrays,
other positions) is replaced with a deterministic hash. Signatures and
blockhashes are dropped (labels are used instead); non-Orca outer instructions
are stubbed and only the Orca instructions' inner receipts are kept. Replaying
them reproduces each position's captured on-chain liquidity exactly.

`meteora-position-history-cbbtc-wbtc.json` contains 30 minimized successful
mainnet receipts (read-only `getTransaction`, jsonParsed, public RPC, captured
2026-10-30) for two Meteora DLMM cbBTC/WBTC positions in
`packages/engine/src/fixtures/meteora-positions-cbbtc-wbtc.json`: an in-range
open (initialize + add in one transaction) and a fully withdrawn position
(open, a second add, 24 fee claims, a remove), plus one maintenance-only
receipt each. Program, event authority, pool, reserve, mint and position keys
are real public program state; every other key in instructions and transfer
receipts (wallets, wallet token accounts, bin arrays) is replaced with a
deterministic hash. Self-CPI event data is kept verbatim. Signatures, logs and
blockhashes are dropped (labels are used instead). Claimed fees replayed from
these receipts equal the position's on-chain `total_claimed_fee_x/y`.
