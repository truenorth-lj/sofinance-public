# `src/lib/dex`: one interface for every DEX

Design: `DESIGN.md` §1 (shared DEX adapter). Every DEX (Raydium CLMM, Meteora DLMM, Uniswap v4 on Robinhood Chain,
Orca Whirlpool, …) implements the same contract. Implementations differ; the interface the rest of the app sees does not.

| File | Side | What |
|---|---|---|
| `types.ts` | client-safe | `DexId` (one canonical spelling, legacy aliases for one release), `DexDescriptor`, `DexMeta`, `DexCapabilities`, `FeePolicy` |
| `adapter.ts` | types | `DexAdapter` (reads + transaction preparation), `PreparedStep`, `StepResult`, `DexFeeStrategy` |
| `errors.ts` | shared | `DexError` / `DexUnsupportedError` (plain-English messages) |
| `fees.ts` | shared | fee-policy validation and the `bpsFeeStrategy` hook |
| `registry.ts` | shared | `createDexDescriptorRegistry` / `createDexRegistry` (lookup, alias resolution, `capabilitiesFor`) |
| `descriptors.ts` → `client.ts` | client | registered descriptors; components import `@/lib/dex/client` |
| `modules.ts` → `index.ts` | server-only | registered modules (descriptor + lazy adapter + pool source); routes, cron, MCP import `@/lib/dex` |
| `__contract__/` | tests | `describeDexContract(module, fixtures)`: the one suite every DEX runs |
| `<id>/` | per DEX | `descriptor.ts`, `adapter.server.ts`, `pool-source.ts`, `module.ts`, fixtures, `<id>.contract.test.ts` |

## Layering

```
L0  packages/engine/src/protocols/<id>/**   builders, decoders, constants; may import DEX SDKs
L1  src/lib/dex/<id>/**                     one DEX's adapter; may import its own L0, shared engine code, src/lib/dex/*.ts
L1s src/lib/dex/*.ts, __contract__/         the contract and registry; never import a src/lib/dex/<id>/ internal
L2  src/app/api/**, src/server/**, src/mcp/**, cron      only "@/lib/dex" (server registry) and "@/lib/dex/client"
L3  src/components/**, pages                only "@/lib/dex/client"
X   src/lib/tx-pipeline/**                  knows no DEX; consumes PreparedStep
```

Rules: no layer above L1 imports a DEX SDK, `@sofinance/engine/protocols/**` or `src/lib/dex/<id>/**`, and no code
outside `src/lib/dex/**` branches on a DEX id or chain string (`protocol === "…"`); protocol differences are `meta`
and `capabilities`. Adapters prepare transactions and read data; signing, sending, the on-chain check after wallet
errors (4001/5000), confirmation and status stay in the shared transaction pipeline.

## Adding a DEX

1. L0 builders under `packages/engine/src/protocols/<id>/`.
2. `src/lib/dex/<id>/{descriptor,adapter.server,pool-source,module}.ts`.
3. One line in `descriptors.ts` and one in `modules.ts`.
4. Recorded fixtures plus `<id>.contract.test.ts` calling `describeDexContract` (`registry.test.ts` fails if a
   registered DEX has none).

## Contract suite rules

- Offline: the vitest setup file `src/lib/test-support/offline-fetch.ts` replaces `fetch` before any module loads, so
  copies captured at load time (`@solana/web3.js` `Connection`) are blocked too; inside the suite every request goes to
  the fixtures' `fetch` replay, and one it does not answer fails the test.
- Nothing supported is skipped: `open` needs `fixtures.open`; add / withdraw / claim / compound / performance need
  `fixtures.positionKey`, and any supported position op needs `fixtures.stranger`: add / withdraw / claim / compound take
  the requesting wallet (`owner`) and must refuse a non-owner with `POSITION_NOT_FOUND` (the adapter checks the
  position's on-chain owner itself; the route is not the only caller). `feeWallet` is required whenever the fee policy charges anything, `open.expectedFeeBaseRaw`
  whenever the open fee is not `none`, and `mintPrograms` for every Solana DEX. Every step of open, add, full and partial withdraw, claim and compound is prepared and checked.
- `position.source` must be the canonical id (aliases are only for old URLs / localStorage via `normalizeDexId`).
- Step checks: ≤ 1232 bytes, a compute-unit limit instruction ≤ 1.4M, owner pays and signs, at most one declared
  cosigner, no direct fee-wallet instruction (`assertNoDirectFeeWalletInstructions`), ATAs only for declared mints and on
  the mint's token program, SystemProgram transfers only to the owner, its wSOL ATA, accounts created in the same tx or
  `fixtures.systemTransferRecipients`, quoted open fee =
  `fees.feeFor("open", base)`, EVM `to` in the allowlist and `approve` only to Permit2; anything thrown is a `DexError`.
- Still per-PR review items: EVM `value` rules (PR11). Meteora's full withdraw closing with rent to the owner is pinned
  in its own specifics test (PR6).

No component, API route, cron job or the transaction pipeline changes.
