These fixtures replay real Jupiter swap instructions plus a Raydium Token-2022
open-position instruction captured during local mainnet simulation on 2026-10-10.
`open-size-route.json` reproduces the original 1,524-byte transaction.
`open-size-compact-route.json` captures the smaller sequential fallback.
`open-rent-token22-mainnet.json` records account keys, spaces, and lamport
deltas from a landed Token-2022 open (sig 4YhXSd5z… on pool DUzBLHZ5…).

Wallet, wallet ATAs, NFT mint and blockhash are replaced with deterministic test
values. No private keys, API credentials, permits or signatures are recorded.
Lookup table entries unused by these instructions are omitted; tests reconstruct
them as the default public key while preserving the original indexes and length.
Fixtures lock down size, account roles, instruction order and retry behavior;
live simulation separately verifies the actual routes and resulting balances.
