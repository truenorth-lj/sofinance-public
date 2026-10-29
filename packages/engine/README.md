# @sofinance/engine

The transaction engine for the public web app, HTTP API and MCP. This package is maintained in
`sofinance-public/packages/engine`; the app consumes it with `workspace:*`.

It was imported from the exact `engine-v0.1.6` source that produced the public app's previous
vendored artifact. All 90 runtime files match that artifact byte for byte at import; see
[provenance.json](provenance.json) for the source commit, tree and content digests. The paused
prototype remains unchanged. Its separate 0.2.0 line is not an upgrade of this imported source.

The package retains its existing `private: true` and `UNLICENSED` metadata. The repository's MIT
license does not relicense this package. This move does not publish an npm package.

## What is inside

Open (`open-atomic`, `open-quote`, `open-state`, `open-simulation`, `open-transaction`, `open-rent`, ...),
compound (`compound-*`, `swap/compound`), withdraw (`withdraw/*`, `lp-exit-*`), the shared swap / fee
layer (`swap/*`, 10 bps default to `SOFINANCE_FEE_WALLET`), Jupiter and resilient RPC clients
(`jupiter/*`, `rpc/*`), and their tests and golden fixtures. Deep imports mirror the
original layout: `src/lib/open-atomic.ts` → `@sofinance/engine/open-atomic`, `src/lib/rpc/index.ts` →
`@sofinance/engine/rpc`. Source ships as TypeScript; hosts transpile it (Next `transpilePackages`).

Not inside: Next routes, Postgres stores, React, permits issued by routes, the prototype's sponsor key.

## Host injection (no ambient env reads)

The engine never reads `process.env`. A host calls once:

```ts
import { configureEngine } from "@sofinance/engine/host";
configureEngine({ env: () => process.env }); // or any snapshot/provider
```

The provider is called on every read (same semantics as the old inline reads). Unconfigured use throws.
Every top-level builder also accepts an injected `connection`.

## Fee payer separation (sponsored mode)

`buildAndSimulateOpenPosition(..., { feePayer })`, `buildAndSimulateCompound(wallet, mint, sources, { feePayer })`
and `buildWithdraw(request, preview, { feePayer })`:

`buildAndSimulateOpenPosition` requires a client-supplied `nftMint` public key (Raydium `getEphemeralSigners`). It returns a fully unsigned v0 transaction; the host must not locally sign the mint. The wallet signs first, then the client (or MCP agent) adds the mint signature on the wallet-returned message (extra Lighthouse / compute-budget instructions are allowed).

- owner mode (omit `feePayer`, or pass the wallet): unchanged instruction bytes aside from a zero NFT-mint signature slot (tests + golden snapshots);
- sponsored mode: the fee payer is the message payer and first signer, funds every new account
  (ATAs, Raydium position NFT/account via `open_position_with_token22_nft` payer, isolated accounts,
  fee-recipient ATA), the wallet's SOL is required not to move (`maxSolDebitLamports = 0`, zero-SOL wallets allowed),
  native-SOL input/output is refused, and recovered rent goes back to the sponsor
  (position close rent via an exact `SystemProgram.transfer`, isolated account closes directly to the sponsor,
  compound prior-account refunds passed through).
- The engine does **not** verify the sponsor's own SOL spend; the host's sponsor guard must (P3).

## Multi-transaction plans

`plan.ts`: `TransactionPlan` (`atomic`, ordered `steps` with required signers and sizes),
`planFromSingleResult`, `planFromWithdrawResult` (withdraw already splits into withdraw + swap stage),
and `packInstructionGroups` for greedy, order-preserving packing into ≤1,232-byte packets.

## RPC provider pool

Every Solana RPC call (`rpcConnection()`, `rpcReadConnection()`, `rpcRequest()`) goes through one
router in `rpc/`. It decides which provider serves the call, keeps each provider under its own
requests-per-second budget, and fails over when one breaks. Callers never pick providers.

### Default: nothing to configure

Without `SOLANA_RPC_PROVIDERS` the router is exactly the 0.1.3 behaviour: `SOLANA_RPC_URL`,
else public mainnet, with the next distinct endpoint as fallback. That
means the same primary concurrency cap (6), the same circuit breaker, no local rate limit, and no
stickiness. `rpc/legacy-equivalence.test.ts` checks this. It runs every method class, circuit state, and
provider outcome through a frozen copy of the 0.1.3 code and through the pool, then compares the
results.

### Adding providers: `SOLANA_RPC_PROVIDERS`

A JSON array, tried in order. Each URL can be written out, or given as `$VAR` to read another env
var. With `$VAR`, the list itself holds no keys and each key stays in its own secret variable.

```json
[
  { "name": "helius",    "url": "$SOLANA_RPC_URL",    "rps": 8 },
  { "name": "alchemy",   "url": "$ALCHEMY_RPC_URL",   "rps": 12 },
  { "name": "quicknode", "url": "$QUICKNODE_RPC_URL", "rps": 12, "exclude": ["getProgramAccounts"] },
  { "name": "public",    "url": "https://api.mainnet-beta.solana.com", "rps": 3 }
]
```

| field | default | meaning |
| --- | --- | --- |
| `name` | required | Log label (`via` in log lines). Letters, digits, `-`, `_`. |
| `url` | required | `https://…`, `$VAR` (another env var; the provider is skipped when it is unset). Endpoints on a retired vendor host (`RETIRED_RPC_HOSTS` in `rpc/urls.ts`) are skipped the same way. |
| `rps` | none | Client-side budget (token bucket, per server instance) **and the read-spreading weight**. Set it a little under the plan limit; a read provider without `rps` gets weight 1. |
| `burst` | `rps` | Bucket size. |
| `maxConcurrency` | none | Max in-flight requests from one instance. |
| `transactions` | `false` | May serve send / simulate / blockhash / confirm. |
| `reads` | `true` | Serves ordinary reads. |
| `exclude` | `[]` | JSON-RPC methods never sent here (`getProgramAccounts` also covers `getParsedProgramAccounts`). |

If the value is invalid, one key-free `{"rpc":true,"config":"invalid",…}` error is logged and the
default pool is used, so a typo cannot take RPC down.

### How a call is routed

- **Transaction route.** Covers send, simulate, blockhash, confirm, block height, and fee. Slot-context
  reads (`getMultipleAccountsInfoAndContext`, `getSlot`) also use it, because their slot later becomes
  a simulation's `minContextSlot`.
  - Uses only providers with `transactions: true`, strictly in the order listed.
  - If no provider has the flag, it uses the default pair above, so adding read providers never moves
    sends.
- **Read route.** Covers everything else.
  - New connections are **spread across healthy read providers in proportion to their `rps`**
    (smooth weighted round-robin, `rpc/select.ts`). With rps 8 / 12 / 5, about 32 / 48 / 20 % of
    requests start on each, interleaved, so no single provider saturates first. Providers with an
    open circuit are not picked, and a provider that excludes the method is skipped for that call.
  - When the chosen provider's budget is spent, the call overflows to the other healthy providers,
    heaviest first, **before** a request is sent. That is proactive, not a 429 first. If no
    provider has budget, the call waits for the chosen provider's next token.
- **Stickiness.** Reads on one connection prefer the provider that served that connection's
  previous call. Use one connection per request, which is what `rpcConnection()` callers already do.
  This keeps a request's slots coherent and avoids "Minimum context slot has not been reached".
  `rpcReadConnection()` is for display-only reads that never simulate. It also lets slot-context
  reads use the read providers.
- **Behind-slot reads.** Providers sit a few slots apart. When a read carries `minContextSlot` (for
  example `readSelectedPositionState`'s sequential reads) and fails over to a provider that has not
  reached that slot, it answers JSON-RPC -32016 "Minimum context slot has not been reached". On the
  read route of a `SOLANA_RPC_PROVIDERS` pool, that error is retried on the same provider after
  0.4 s, 0.8 s, 1.2 s (about one slot each; shares the normal retry budget and rate limit). The
  transaction route, sends, and the default pair (env unset) are unchanged: there the error is still
  thrown at once. Retry lines carry `"reason":"min-context-slot"`.
- **Failover.** Same-provider retries handle 429, 5xx, and timeouts. After that, errors listed in the
  method's policy move the call down the list.
  - Each provider has its own circuit breaker:
    - auth: 30 s
    - two 5xx or timeouts in a row: 10 s
    - 429: its `Retry-After`, up to 30 s for pool providers
  - A provider with an open circuit is skipped, but the last one in the list is always tried.
- **Logs.** Lines are key- and URL-free. Every fallback is logged (`console.warn`); set
  `SOFINANCE_RPC_LOG=1` to log every call. Example:
  `{"rpc":true,"method":"getBalance","provider":"default","via":"alchemy","outcome":"fallback","status":"rate-limit","reason":"primary-error",…}`
  - `reason`: `primary-error`, `circuit-open`, or `local-rate-limit` (overflow; logged as `ok`);
    `min-context-slot` on retry lines (only with `SOFINANCE_RPC_LOG=1`).

### Provider free tiers (checked 2026-10)

| provider | free-tier limit | notes |
| --- | --- | --- |
| Helius | 10 req/s RPC; `getProgramAccounts` 5 req/s and 10 credits; `sendTransaction` 1/s; 1M credits/month | [rate limits](https://www.helius.dev/docs/billing/rate-limits), [pricing](https://www.helius.dev/pricing) |
| Alchemy | 300 CU/s (≈15 req/s), 30M CU/month. Limit is a 10 s rolling token bucket. `getProgramAccounts` is 20 CU, but 117 *throughput* CU (≈2.5/s) | [throughput](https://www.alchemy.com/docs/reference/throughput), [getProgramAccounts](https://www.alchemy.com/docs/chains/solana/solana-api-endpoints/get-program-accounts) |
| QuickNode | Free **trial** (1 month): 15 req/s, 10M credits. `getProgramAccounts` capped at 3 req/s on every plan | [pricing](https://www.quicknode.com/pricing), [getProgramAccounts](https://www.quicknode.com/docs/solana/getProgramAccounts) |
| Solana public | 100 req / 10 s per IP, 40 req / 10 s per method, 40 concurrent connections; "not intended for production" | [clusters](https://solana.com/docs/references/clusters) |

None of these free tiers blocks `getProgramAccounts` outright; they rate-limit it more tightly. The
engine does not call it today. Exclude it on a provider if a future feature needs heavy scans.

## Tests

`pnpm --filter @sofinance/engine test` / `typecheck` (also run by the root `pnpm test` / `pnpm typecheck`).

## Development and packaging

Change engine code and its app consumers in this repository, then run `pnpm test` and
`pnpm typecheck` from the root; both commands include the engine package. Runtime exports
remain TypeScript deep imports and the app configures the engine once through `src/lib/engine-host.ts`.

`pnpm --filter @sofinance/engine pack --pack-destination <directory>` creates a local consumer
artifact. Tests, snapshots, fixtures and test-support are excluded; provenance is included.
No registry publication or external consumer migration is required for this workspace.
Future releases must use a new version and record their own source identity rather than replacing
an existing artifact. The import provenance records the migration baseline, not later revisions.
