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
4. Recorded fixtures plus `<id>.contract.test.ts` calling `describeDexContract`.

No component, API route, cron job or the transaction pipeline changes.
