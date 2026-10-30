# SoFinance

Non-custodial Solana tooling for **Raydium CLMM** liquidity: zap any eligible wallet asset into a position via Jupiter, and compound fees/rewards back in—with the same safety gates for humans and AI agents.

One shared workspace engine in `packages/engine`, with application policies in `src/lib`, powers:

- a **Next.js web app** (wallet connect → quote → sign → broadcast)
- an **MCP server** (`src/mcp/`) that returns **unsigned v0 transactions** for agents to sign

The server never holds private keys. Agents/users sign locally; broadcast re-verifies an HMAC permit and re-simulates before send. Open-position uses Phantom’s multi-signer recipe: the browser (or agent) generates the position NFT mint, the wallet signs the unsigned transaction first, then the mint signature is added on the transaction the wallet returns (including any extra Lighthouse / compute-budget instructions Phantom added). HTTP withdraw and other single-signer flows broadcast that wallet-returned transaction after a cheap sanity check.

The marketing landing page lives at `/`. Product UI lives under `/app` (Positions and the Solana + Robinhood Chain pool list, Plan, position performance, Use AI, and sign deep-links). `/api/*` is unchanged.

| Old path | New path |
|----------|----------|
| `/` (app home) | `/app` |
| `/rwa-pairs`, `/app/rwa-pairs` | `/app#pools` (`?pool=<id>&open=1` becomes `?openPool=<id>`; `ref` / `utm_*` kept) |
| `/position-performance` | `/app/position-performance` |
| `/ai` | `/app/ai` |
| `/sign/<token>` | `/app/sign/<token>` |

Former page paths permanently redirect. MCP `prepare_*` tools now emit `/app/sign/<token>`.

**Docs:** [Self-hosting](#self-hosting) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## Quick start for judges

- **Live app:** https://sofinancelab.xyz
- **Demo video:** https://www.youtube.com/watch?v=vVW_z4Iiw8Y
- **Official X:** https://x.com/SoFinancelab
- **Colosseum project:** https://colosseum.com/arena/projects/16410

### Infrastructure

- **RPC** (`packages/engine/src/rpc/providers.ts`, `packages/engine/src/rpc/urls.ts`): server RPC uses `SOLANA_RPC_URL` when set, else the public mainnet RPC; eligible failures fall back to the next distinct provider. `SOLANA_RPC_PROVIDERS` can override this with an explicit pool. Endpoints on retired vendor hosts (`RETIRED_RPC_HOSTS`, currently `solami.dev`) are skipped like an unset `$VAR`. Position performance discovers history with `getSignaturesForAddress` plus batched `getParsedTransaction` (`src/lib/position-performance-history.ts`, `src/lib/position-performance-math.ts`).
- **Pool activity:** removed. The live pool-activity feature (MCP `get_pool_activity`, `/api/pool-activity` + `/stream`, the live pool-activity panel / swap ticker) was deleted; `get_position_range_status` uses the on-chain pool price.
- **No transaction tips.** Prepared transactions contain only the flow's own instructions (plus the optional protocol fee); they are sent with `sendRawTransaction` through the RPC layer above.

### Run locally

Requires Node 24 (`.node-version`, matching CI and the service Docker image) and pnpm 10.18.2 (`packageManager` in `package.json`).

```bash
corepack enable
pnpm install
cp .env.example .env.local   # fill in your own keys
pnpm dev                     # http://localhost:3000
```

Server-only RPC: set `SOLANA_RPC_URL` (never prefix with `NEXT_PUBLIC_`); unset = public mainnet RPC. Other variables (`JUPITER_API_KEY`, `NEXT_PUBLIC_REOWN_PROJECT_ID`, `NEXT_PUBLIC_APP_URL`, …) are documented in `.env.example`.

## Self-hosting

Run your own instance of the Next.js app (web UI + `/api/*` + remote MCP). This is the same flow as [Run locally](#run-locally) with env, build, Docker, and MCP client notes spelled out.

### Clone and install

Requires Node 24 and pnpm 10.18.2 (`packageManager` in `package.json`).

```bash
git clone https://github.com/truenorth-lj/sofinance-public.git
cd sofinance-public
corepack enable
pnpm install
cp .env.example .env.local   # fill in your own keys; never commit this file
```

### Environment

Copy `.env.example` → `.env.local`. Comments in that file are the source of truth. Do not prefix server secrets with `NEXT_PUBLIC_`.

**Typically required for a useful instance**

| Variable | Role |
|----------|------|
| `JUPITER_API_KEY` | Jupiter quotes plus HMAC secret for permits, sign tokens, and MCP tokens |
| `NEXT_PUBLIC_REOWN_PROJECT_ID` | Wallet connect in the web UI ([Reown dashboard](https://dashboard.reown.com/)) |
| `NEXT_PUBLIC_APP_URL` | Absolute MCP and sign-link URLs (local: `http://localhost:3000`; production auto-detects `VERCEL_URL`) |

**RPC** — `SOLANA_RPC_URL` (optional, recommended). If unset, server RPC uses public mainnet.

**Optional**

| Variable | Role |
|----------|------|
| `NEXT_PUBLIC_SOLANA_RPC_URL` | Browser wallet RPC only; must be a public endpoint, never a key |
| `SOFINANCE_FEE_WALLET` / `SOFINANCE_FEE_BPS` | Optional protocol fee; **server-only, never `NEXT_PUBLIC_`**. Default 10 bps, max 100. Unset wallet = fee 0, no transfer added. Details: [Protocol swap fee](#protocol-swap-fee). |
| `RHC_UNIV4_FEE_WALLET` | Robinhood Chain (4663) Uniswap v4 open fee recipient (10 bps `TAKE_PORTION` of the swap output); **server-only, never `NEXT_PUBLIC_`**. Must be an EIP-55 checksummed EVM address. Unset or invalid = every RHC open fails closed (`fee-wallet-unconfigured`, "Fee wallet not configured"). |
| RWA / history DB vars | Explicit `gateway` (default) or direct TLS `neon` mode; native cron defaults off. See `.env.example`, [DB docs](db/README.md) and [cutover runbook](db/neon-vercel-cutover.md) |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_DSN` | Optional Sentry error monitoring (US, `ingest.us.sentry.io`). Unset both = complete no-op. |
| `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` | Source-map upload on `next build`. All three required to upload; build succeeds if any is missing. Never `NEXT_PUBLIC_`. See [Error monitoring](#error-monitoring-sentry). |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | Optional PostHog product analytics. Unset key = complete client no-op. The browser always sends to the first-party relay `/lumen` (Next.js rewrite); the host only picks the upstream region and defaults to `https://us.i.posthog.com`. |
| `SOFINANCE_OPENS_DATABASE_URL` | Optional Postgres URL (Neon / Vercel Postgres) for north-star open logs. Unset = log nothing. Not the Zeabur RWA `DATABASE_URL`. |
| `SOFINANCE_OPENS_READ_TOKEN` | Bearer token (≥32 chars) for `GET /api/internal/opens-daily`. Unset = route 404s. |

See [Growth analytics](#growth-analytics) for event names and the internal read endpoint.

### Run

```bash
pnpm dev                     # http://localhost:3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build
pnpm start                   # after build
```

`pnpm mcp:start` runs the local stdio MCP server (needs `SOLANA_RPC_URL` and `JUPITER_API_KEY` in the environment).

### Docker

The `Dockerfile` builds the **optional RWA snapshot data service** (`scripts/rwa-data-service.ts`), not the Next.js web app. It needs `DATABASE_URL` and a `CRON_SECRET` of at least 32 characters.

```bash
docker build -t sofinance-rwa-service .
docker run --env-file .env.local -p 3000:3000 sofinance-rwa-service
```

The web UI and MCP HTTP endpoint are the Next.js app (`pnpm dev` / `pnpm build && pnpm start`, or Vercel).

### Error monitoring (Sentry)

Optional `@sentry/nextjs` client, server, and edge setup. The production/preview project is **sofinance / sofinance-public** in the US region (`ingest.us.sentry.io`).

| Variable | Role |
|----------|------|
| `NEXT_PUBLIC_SENTRY_DSN` | Browser + bundled client DSN. Unset with `SENTRY_DSN` = SDK is disabled. |
| `SENTRY_DSN` | Server/edge DSN fallback if the public var is unset. |
| `NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE` / `SENTRY_TRACES_SAMPLE_RATE` | Trace sample rate 0–1 (default `0.1`). |
| `SENTRY_AUTH_TOKEN` | Source-map upload token. Server-only; never `NEXT_PUBLIC_`. |
| `SENTRY_ORG` | Sentry org slug (`sofinance`). |
| `SENTRY_PROJECT` | Sentry project slug (`sofinance-public`). |

Session Replay is off. `sendDefaultPii` is false. Events scrub wallet addresses, signatures, RPC URLs, API keys, `x-vercel-*` / IP / `Authorization` / `Cookie` headers, and drop `user.ip_address`. API captures are 5xx and Jupiter/RPC upstream only (not validation 4xx or user-rejected). The `route` tag comes from the request path / Next transaction, not a bundled stack.

### Point an MCP client at your instance

1. Set `NEXT_PUBLIC_APP_URL` to the origin you will expose (for example `http://localhost:3000` or `https://your-host.example`).
2. Start the Next.js app. On `/app/ai`, use **Sign to get MCP config**.
3. In the generated config, use your origin instead of production:

```json
{
  "mcpServers": {
    "sofinance": {
      "url": "https://your-host.example/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-token-here>"
      }
    }
  }
}
```

Local stdio against this checkout: see [Quickstart — MCP for AI Agents](#quickstart-mcp-for-ai-agents-remote-zero-local-secrets) (Option B shim with `SOFINANCE_MCP_URL`, or Alternative: Local MCP with `pnpm mcp:start`).

## Features

- Discover Raydium CLMM position NFTs and eligible ATA / native SOL balances
- **Add-liquidity zap**: Jupiter Swap V2 + Raydium `increase_liquidity_v2` in one simulated v0 tx
- Configurable **add-liquidity price tolerance** (default 1%, cap 5%) so pool drift does not trip Raydium `PriceSlippageCheck` (6017); unused reserve stays in the wallet
- **Resale-ratio floor** (default 99%): conservative quote of swapping position outputs back to the same input asset
- **One-click compound**: harvest fees/rewards, swap to range ratio, reinvest (phase one rejects third reward mints without a verifiable path)
- Web UI Advanced settings for resale gap and price tolerance; MCP exposes the same knobs
- **Position performance / realized fee APR**: holding-period return from on-chain open/increase/decrease events + current equity (not Raydium pool 24h feeApr). Same-asset RWA pairs prefer **token-equivalent (TE)** in the plain/base ticker via current tick mid (raw A/B + TE; USD secondary) — MCP `get_position_performance`, `/api/position-performance`, `/app/position-performance` UI
- **Live range status**: in-range / near-edge status from the on-chain pool price versus the position ticks — MCP `get_position_range_status`
- **Same-asset RWA pair discovery**: Raydium CLMM pools where both sides are the same underlying (e.g. `MSTRx`/`MSTR`, `NVDAx`/`NVDA`), filtered by Jupiter Tokens API tags (`stocks`|`rwa`) plus Backed xStocks whitelist, with fee tier, TVL, 24h volume/fees, estimated fee APR, Token-2022 / freeze flags — MCP `list_rwa_pairs` and the `/app#pools` pool list
- **Open CLMM position**: create a new Raydium concentrated position from the `/app#pools` pool list (Open position) or MCP `quote_open_position` / `prepare_open_position` / `submit_open_position`, with Jupiter swap-to-ratio, range presets (web UI adds a **Micro** band, an estimated fee APR per preset, and an **Best** button that picks the candidate with the highest estimated APR; see `docs/rwa-range-apr.md`), and the same quote → prepare → sign → re-sim gates. No need to open the NFT on raydium.io first. The position NFT mint is an ephemeral **client** Keypair: `/api/open-prepare` takes its public key and returns a fully unsigned v0 tx. The wallet `signTransaction`s first (Phantom recipe); the client then adds the mint signature on the returned tx (extras such as Lighthouse are allowed) and zeroes the secret. Dedicated `submit_open_position` (not `submit_signed_transaction`) because this message has two required signers. MCP agents should pass `nftMint` and mint-sign after the wallet; without it, `/app/sign/<token>` generates the mint in the browser, re-prepares via `/api/sign-open-prepare`, and signs it after the wallet (the server never holds a mint secret).

## Safety gates

Kept on both web API and MCP paths:

| Gate | Role |
|------|------|
| Price-impact cap | 5% vs probe route (`MAX_PRICE_IMPACT_BPS`) |
| Resale-ratio floor | 95–100% in 0.1% steps (default 99%) |
| Jupiter swap slippage | Fixed 0.5% |
| Add-liquidity tolerance | 0–5% (default 1%); pads `amountMax`, shrinks liquidity |
| 1,232-byte limit | Rejects oversized v0 messages |
| Full simulation | Exact liquidity delta + balance checks before signing |
| HMAC permit | Binds message, wallet, selection, amounts, floor, starting state |
| Re-verify | On submit: permit, on-chain state, re-simulate, then broadcast |

## MCP tools (16; 15 in production)

| Tool | Purpose | Key params |
|------|---------|------------|
| `get_position_performance` | Holding-period / fee APR from chain; TE for same-asset RWA wrap pairs | `positionMint`, `wallet?`, `maxSignatures?`, `skipPricing?` |
| `get_position_range_status` | In/out of range from the on-chain pool price vs position ticks; near-edge flag | `positionMint`, `wallet?`, `poolId?` |
| `list_positions` | Positions + eligible assets | `wallet` |
| `quote_add_liquidity` | Read-only zap quote | `wallet`, `positionMint`, `inputMint`, `inputKind` (`native`\|`token`), `amount`, `resaleFloorBps?` (9500–10000, default 9900), `slippageToleranceBps?` (0–500 step 10, default 100) |
| `prepare_transaction` | Unsigned zap tx + permit + `submitArgs` + `signUrl` | same as quote |
| `submit_signed_transaction` | Permit check → re-sim → broadcast | `signedTransaction` + every `submitArgs` field unchanged |
| `quote_compound` | Compound quote | `wallet`, `positionMint`, `sourceSignatures?` (≤3) |
| `prepare_compound_transaction` | Unsigned compound tx + permit + `signUrl` | same as quote_compound |
| `submit_compound_transaction` | Permit check → re-sim → broadcast | `signedTransaction`, `permit`, `wallet`, full `summary` unchanged |
| `list_rwa_pairs` | Discover same-asset RWA pairs; includes `openPositionUrl` + `recommendedRanges`. Defaults `maxPages=3`; uses the in-memory cache when warm | `minTvl?`, `maxPages?`, `sortBy?` |
| `quote_open_position` | Quote a **new** CLMM position (no existing NFT) | `wallet`, `poolId`, `inputMint`, `inputKind`, `amount`, `rangePreset?` (`tight`\|`standard`\|`wide`\|`custom`), `minPrice?`/`maxPrice?` (B per 1 A) |
| `prepare_open_position` | Unsigned open-position tx + permit + `signUrl`. Prefer `nftMint` (agent signs mint after wallet). Without `nftMint`, use `signUrl` (browser-generated mint; returned tx is a preview). | same as quote_open_position, plus optional `nftMint` |
| `submit_open_position` | Permit check → re-sim → broadcast (two signers: wallet + NFT mint) | `signedTransaction`, `permit`, `wallet`, full `summary` unchanged |
| `prepare_withdraw` | Simulated withdrawal + permit + sign link; supports two-stage withdrawal | `wallet`, `positionMint`, `percent` or `targetUSDC`, `receive?`, `outputMint?`, `confirmHighImpact?`; second stage: `stage=swap`, `tx1Signature`, complete `previous` result |
| `submit_withdraw` | Permit/signature/expiry check → re-sim → broadcast | `wallet`, `signedTransaction`, `permit`, full `summary` unchanged, `confirmHighImpact?` |

## Quickstart — web

```bash
pnpm install
cp .env.example .env.local
# Server-only: SOLANA_RPC_URL, JUPITER_API_KEY
# Optional protocol fee: SOFINANCE_FEE_WALLET + SOFINANCE_FEE_BPS (default 10, max 100). Unset wallet = fee 0.
# Public: NEXT_PUBLIC_REOWN_PROJECT_ID (and optional NEXT_PUBLIC_SOLANA_RPC_URL without secrets)
pnpm dev --webpack --hostname 127.0.0.1
```

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Never commit `.env.local`, mnemonics, or API keys. Do not prefix `SOLANA_RPC_URL` / `JUPITER_API_KEY` / `SOFINANCE_FEE_WALLET` / `SOFINANCE_FEE_BPS` with `NEXT_PUBLIC_`.

### Protocol swap fee

Implementation and detailed audit: [shared swap module](src/lib/swap/README.md).

When `SOFINANCE_FEE_WALLET` is set (Vercel env, server-only), fee-enabled open-position, selected-add, and compound flows take `SOFINANCE_FEE_BPS` (default 10, max 100) of the **input token** inside the same atomic v0 transaction the wallet signs, transferred to the fee wallet’s ATA for that mint (created if missing; the user pays ATA rent). Unset wallet keeps fee 0. A floored-zero fee adds no transfer and no recipient ATA. There is no performance fee on compound / LP earnings.

- Open position: 10 bps of the deposited token as an SPL/SOL transfer; Jupiter `/build` amount is the net after the fee. Sequential secondary legs are not charged again. Resale-floor probes are not charged.
- Selected-position add: the same 10 bps input-token transfer as open.
- One-click compound (Raydium): 10 bps of the isolated swap-input (harvested tokens being reinvested) as an SPL transfer before the in-pool rebalance — not a performance fee on earnings.
- Withdraw to USDC: unchanged Jupiter `platformFee` in USDC. Original-token withdraw is 0.

Quote/prepare JSON includes `feeBps` / `feeAmount` / `feeWallet`. `feeAmount` is in the input mint for open / selected / compound. Rent estimates are unchanged; ATA rent for a new recipient token account is allowed in the simulated SOL debit cap only.

## RPC and Jupiter layers

| Surface | When | What it does |
|---------|------|----------------|
| **RPC** | always (`SOLANA_RPC_URL` optional) | All server RPC (`rpcConnection()` / `rpcRequest()`) goes through `@sofinance/engine/rpc` (`SOLANA_RPC_URL` → public). 429 / 5xx / timeouts retry on the same provider with exponential backoff + jitter (honors `Retry-After`, bounded budget, `AbortSignal`), then fail over. Auth/plan errors (401/402/403) and JSON-RPC `-32005` skip same-provider retry and fail over immediately, including simulate / blockhash / height / fee / send / confirm. Re-broadcasting the same signed transaction is idempotent by signature. A short circuit-breaker then skips a dead primary until a small cooldown elapses. Exit-preview uses a longer 25s per-call budget and coalesces identical position reads for 8s. Safe reads (`getAccountInfo`, `getMultipleAccounts*`, `getTokenLargestAccounts`, finalized/confirmed `getParsedTransaction`) use a small in-process TTL cache with in-flight de-dupe — never sends, simulates, or blockhash/height calls. Per-method fallback rules live in `METHOD_POLICIES`. Fallback reasons are always logged as key-free JSON; set `SOFINANCE_RPC_LOG=1` for per-attempt lines. |
| **Jupiter** | `JUPITER_API_KEY` (Portal) | All Jupiter HTTP goes through `packages/engine/src/jupiter/` to `https://api.jup.ag` with `x-api-key` (`lite-api.jup.ag` is retired). 429 / 5xx / timeouts retry with jitter + `Retry-After` / `x-ratelimit-reset`, bounded budget, `AbortSignal`. Read-only quotes cache 8s (key: input/output mint, amount, slippage, maxAccounts) with in-flight de-dupe; POST `/swap-instructions` is not cached. Exit-preview quotes legs in parallel (cap 2) and logs the real error class/message on failure (always-on, key-free). Upstream Jupiter 429/5xx return `errorCode: "jupiter_unavailable"` — not the Solana RPC text. `SOFINANCE_JUPITER_LOG=1` or `SOFINANCE_RPC_LOG=1` logs per-call Jupiter lines. |

Position performance reports `{ txCount, elapsedMs, provider, defaultTxCount, fallbackReasons }`.

```
wallet / API / MCP
        │
        ▼
 packages/engine/src/rpc/ ── SOLANA_RPC_URL? ──► dedicated RPC
        │                    else ──► public RPC
        │         retry 429/5xx/timeout → then next provider
        │         cache safe reads (per-instance, best effort)
        ▼
 position-performance / exit-preview / MCP
   history: getSignaturesForAddress + batched getParsedTransaction (8-wide)
```

### Demo checklist (RPC layer)

1. Set `SOLANA_RPC_URL` (or leave it unset for public RPC) and open `/app/position-performance`.
2. Compute performance for a real mainnet position NFT.
3. Confirm the history line shows a tx count / elapsed ms and `provider: default`.

## Quickstart — MCP for AI Agents (Remote, Zero Local Secrets)

**Recommended:** Use the remote MCP endpoint with zero local secrets. The MCP server runs on Vercel; your laptop needs only a connection URL + auth token.

### Getting Started (Remote MCP)

1. **Connect your wallet** on [sofinancelab.xyz/app](https://sofinancelab.xyz/app) (or `/app/ai`)
2. **Click "Sign to get MCP config"** — a WalletConnect session is not ownership proof. Each challenge nonce is single-use in-process (2-minute window). Vercel isolates do not share that store; a replay on a different isolate can still mint until the window expires.
3. **Sign the challenge message** in your wallet (proves you control the key)
4. **Copy the generated config** — includes a short-lived token bound to your wallet
5. **Paste into your AI agent:**

   **Cursor / Claude (if HTTP MCP supported):** Use the direct HTTP config

   **Cursor / Claude (if stdio only):** Use the zero-secret shim config

The UI shows both configs after you sign. Choose based on what your agent supports.

### Option A: Direct HTTP (Preferred)

If Cursor/Claude supports HTTP MCP with custom headers:

```json
{
  "mcpServers": {
    "sofinance": {
      "url": "https://sofinancelab.xyz/api/mcp",
      "headers": {
        "Authorization": "Bearer <your-token-here>"
      }
    }
  }
}
```

### Option B: Zero-Secret Shim (Fallback)

If your agent only supports stdio, use this shim that requires ZERO RPC/Jupiter secrets:

```json
{
  "mcpServers": {
    "sofinance": {
      "command": "npx",
      "args": ["tsx", "src/mcp/remote-shim.ts"],
      "cwd": "/absolute/path/to/sofinance-public",
      "env": {
        "SOFINANCE_MCP_URL": "https://sofinancelab.xyz/api/mcp",
        "SOFINANCE_MCP_TOKEN": "<your-token-here>"
      }
    }
  }
}
```

**Benefits:**
- ✅ Zero local secrets (no SOLANA_RPC_URL or JUPITER_API_KEY on laptop)
- ✅ Signature-verified tokens (prove wallet ownership before minting)
- ✅ Always up-to-date (talks to production Vercel backend)
- ✅ Short-lived tokens (24h expiry, regenerate anytime)
- ✅ Wallet-bound auth (token only works for your wallet)

**Agent flow:** `list_positions` → `quote_add_liquidity` → `prepare_transaction` → wallet signs locally → `submit_signed_transaction`. Open a new RWA position: `list_rwa_pairs` → `quote_open_position` → `prepare_open_position` → sign via `signUrl` → `list_positions`. Server never holds your private keys.

### Alternative: Local MCP (Power Users)

For local development or testing, you can run the MCP server locally:

```bash
pnpm install
pnpm mcp:start  # Requires SOLANA_RPC_URL and JUPITER_API_KEY in env
```

Cursor / Claude config for local stdio:

```json
{
  "mcpServers": {
    "sofinance": {
      "command": "npx",
      "args": ["tsx", "src/mcp/server.ts"],
      "cwd": "/absolute/path/to/sofinance-public",
      "env": {
        "SOLANA_RPC_URL": "https://your-solana-rpc",
        "JUPITER_API_KEY": "your-jupiter-key",
        "NEXT_PUBLIC_APP_URL": "https://sofinancelab.xyz"
      }
    }
  }
}
```

Or: `pnpm mcp:start` with env already exported.

**Agent flow:** `list_positions` → `quote_add_liquidity` → `prepare_transaction` → wallet signs `unsignedTransaction` → `submit_signed_transaction` with `{ signedTransaction, ...submitArgs }`. Compound: `quote_compound` / `prepare_compound_transaction` → sign → `submit_compound_transaction` with the complete `summary`. Open position: `list_rwa_pairs` → `quote_open_position` → `prepare_open_position` → sign → `submit_open_position` with the complete `summary`.

**Sign deep-link:** After `prepare_transaction`, `prepare_compound_transaction`, or `prepare_open_position`, the agent receives a `signUrl` (e.g. `https://sofinancelab.xyz/app/sign/<token>`) that can be opened in a browser. Legacy `/sign/<token>` URLs permanently redirect to `/app/sign/<token>`. The token is a self-contained, HMAC-signed, compressed payload containing the unsigned transaction, permit, and submit arguments. With the correct wallet connected via Reown AppKit, the user reviews the transaction summary and signs with one click. The signed transaction is automatically submitted via the existing re-verification and broadcast paths. This bridges the gap for agents that can prepare transactions but delegate signing to the user's wallet UI. Sign tokens expire after 60-120 seconds (matching permit/blockhash lifetime). The token is verified server-side using `JUPITER_API_KEY` as the HMAC secret, so MCP (local/remote) and Vercel (production) can share the same signing mechanism without shared memory.

`JUPITER_API_KEY` is used for Jupiter swap quotes, permit HMACs, sign token HMACs, and MCP token HMACs. Quotes expire quickly; always re-prepare before signing.

## Growth analytics

Optional. Local dev, forks, and tests stay a no-op until the PostHog key and/or opens database URL are set.

**PostHog (browser, `posthog-js`)** — init only when `NEXT_PUBLIC_POSTHOG_KEY` is set. Autocapture, heatmaps, web vitals, surveys, and session recording off; Do Not Track respected. Requests go to `/lumen/*` on our own domain, which `next.config.ts` rewrites to PostHog (`us.i.posthog.com` for events, `us-assets.i.posthog.com` for `/static` and `/array`), so ad blockers that block `*.posthog.com` don't drop events. `/lumen` is excluded from the Proxy matcher and disallowed in `robots.txt`. First-touch `ref` (`?ref=x-<slug>`) and `utm_*` are stored in localStorage and registered as PostHog super/person properties so later events keep attribution.

| Event | When | Properties |
|-------|------|------------|
| `$pageview` | App Router route changes (including `/` and `/app`; `/app/rwa-pairs` now redirects to `/app#pools` with `ref` kept) | `$pathname`, `$current_url` |
| `rwa_pairs_view` | Retired with `/app/rwa-pairs` (no longer sent; use the `/app` `$pageview` and its `ref`) | — |
| `wallet_connect_clicked` | User opens the wallet picker (any Connect wallet button) | none |
| `wallet_connected` | Wallet connects (also on auto-reconnect after a hard load) | none (identify uses `wallet:<sha256>`, not the address) |
| `performance_view` | Performance tab shown in `/app` (tab click or `?view=performance` deep link); the URL doesn't change, so `$pageview` can't see it | none |
| `open_position_started` | User starts an open (prepare/sign) | `pool`, `pair` when known |
| `open_position_success` | Open confirmed on-chain via `/api/open-status` | `pool`, `pair` |
| `open_position_failed` | Open failed before send, or on-chain failed/expired | `error_class` only (never raw error text) |

**North-star opens log (server)** — after a successful open broadcast (`/api/open-broadcast` and MCP `submit_open_position`), best-effort insert into Postgres: UTC time, wallet, pool, pair symbols, USDC notional when the input is USDC, tx signature (unique), `sourceRef` if the client sends the first-touch `ref`. Failures never delay or fail the broadcast. Idempotent DDL: `src/lib/opens-log/schema.sql` (also applied on first write).

Read path (GTM):

```bash
curl -sS -H "Authorization: Bearer $SOFINANCE_OPENS_READ_TOKEN" \
  "https://sofinancelab.xyz/api/internal/opens-daily?days=90"
curl -sS -H "Authorization: Bearer $SOFINANCE_OPENS_READ_TOKEN" \
  "https://sofinancelab.xyz/api/internal/opens-daily?days=90&format=csv"
```

JSON fields per UTC day: `opens`, `uniqueWallets`, `newUniqueWallets`, `notionalUsd`, `byRef[]`. The fee wallet is not included.

## Architecture

```mermaid
flowchart LR
  Web[Next.js web UI] --> API[App Router HTTP API]
  Agent[MCP client] --> HTTP[MCP HTTP route]
  Agent --> Stdio[MCP stdio server]
  API --> App["App policy and orchestration: src/lib"]
  HTTP --> Tools["MCP policy: src/mcp/tools.ts"]
  Stdio --> Tools
  Tools --> App
  Tools --> Engine
  App --> Engine["packages/engine: builders, simulation, RPC, Jupiter"]
  App --> Store["App storage adapters: PostgreSQL / RWA gateway"]
  Engine --> Providers[RPC / Jupiter / Raydium]
```

The app owns HTTP/MCP authorization, app-specific permit and transaction-flow policies,
UI lifecycle and concrete storage adapters. `packages/engine` owns reusable transaction
builders, provider clients and shared attempt, receipt and recovery primitives, including
compound attempt parsing and persistence through storage interfaces. MCP tools currently
call both app orchestration and engine functions directly. `src/lib/engine-host.ts` supplies
engine host configuration. Some HTTP/MCP orchestration is still duplicated; consolidating
those use cases is the next refactor stage.

Stack: Next.js 16 / React 19 / TypeScript / pnpm / Vitest; `@raydium-io/raydium-sdk-v2`, Jupiter `/swap/v2/build`, `@solana/web3.js`, Zod, MCP SDK.

### RPC provider layer

Callers import `rpcConnection()`, `rpcReadConnection()` or `rpcRequest()` from
`@sofinance/engine/rpc`. Provider selection, retries, method policies, per-provider rate limits
and safe-read caching live in `packages/engine/src/rpc/`. Reads may use weighted provider
rotation; eligible failures can fall back across providers, including sends of the same signed
transaction. A later retry rejection does not prove that an earlier send was never accepted;
app attempt recovery retains the original signature until reconciliation.

Configure a provider pool with `SOLANA_RPC_PROVIDERS`; see the maintained
[engine RPC provider documentation](packages/engine/README.md#rpc-provider-pool) for default
routing, method capabilities, retry and cache policies. Add provider policy in that package,
not in individual quote/send/MCP callers. The cache is per process; `RpcCacheStore` is the
extension point for a shared store.

Position history listing and parsing live in `src/lib/position-performance-history.ts`.

## RWA same-asset pairing

Discovers Raydium CLMM pools via the official API (`/pools/info/list?poolType=concentrated`) where both mints are the same underlying asset:

1. **Structural**: symbols form a wrap pair `FOOx`/`FOO`, `FOO-x`/`FOO`, or `xFOO`/`FOO` (stablecoin bases excluded)
2. **Primary**: both mints have Jupiter Tokens API tags including `stocks` **or** `rwa` (`GET /tokens/v2/search?query={mint}`; optional `JUPITER_API_KEY`). Preferred tags `xstocks` / `backpack` are noted when present but not required
3. **Secondary**: Backed xStocks public assets whitelist (`https://api.xstocks.fi/api/v2/public/assets`, Solana deployments) so known Backed mints still qualify if Jupiter tags lag

Name heuristics are not used as the primary filter. Annotated with fee tier, TVL, 24h volume/fees, Raydium `feeApr`, and **estimated fee APR** = `(24h fees / TVL) × 365 × 100` (labeled in API/UI; not a promise of LP returns). Freeze / Token-2022 flags come from Raydium mint metadata tags/program ids.


## Position performance (realized fee APR)

Computes a position NFT's **actual holding-period return** from on-chain facts (no database):

1. Load personal-position history: `getSignaturesForAddress` plus bounded-parallel `getParsedTransaction` batches (not a sequential N+1 loop)
2. Parse Anchor events from logs: `CreatePersonalPositionEvent`, `IncreaseLiquidityEvent`, `DecreaseLiquidityEvent` (exact deposit / principal-out / fee-out amounts)
3. Current equity = liquidity token amounts (`LiquidityMath`) + uncollected fees (fee-growth accrual, same math as compound)
4. Metrics: `holdingDays`, deposited / withdrawn / fees, PnL, `holdingPeriodReturnPct`, `annualizedReturnPct` (simple ×365/days; **null when the position is younger than 24h**), `feeOnlyAprPct`
5. Optional USD via Jupiter Price API v3 **at evaluation time** (explicitly labeled — not historical tx-time prices)

This is **not** Raydium's pool `day.feeApr`. Read-only UI: `/app/position-performance`.

## Limitations

- Raydium **CLMM** positions held directly by the wallet only (not staked, not Orca/Meteora)
- Single-signer v0 transactions; routes that write unrelated non-zero token accounts are rejected
- Quotes and permits expire; blockhash / state changes void a prepare
- Phase-one compound rejects positions with a third reward token lacking a verifiable isolated swap path
- Jupiter free-tier rate limits and public RPC 429s can interrupt quotes; use a dedicated RPC in production

## Roadmap

- Broader Token-2022 / fee / reward coverage for compound
- Clearer agent-facing error codes and recovery hints
- Optional ALT / route shaping to reduce 1232-byte failures on heavy Jupiter paths
- More pool venues only if the same simulation + permit model can be preserved

## Custom domain / `app.` subdomain

The canonical production app URL is [sofinancelab.xyz/app](https://sofinancelab.xyz/app). Use `https://sofinancelab.xyz` for production links and verify releases on this custom domain. `*.vercel.app` domains are no longer used as production links or release-verification targets. An optional `app.` subdomain can be enabled by adding `app.sofinancelab.xyz` in Vercel. `src/proxy.ts` (Next.js 16 Proxy, formerly middleware) rewrites `app.<domain>/<path>` → `/app/<path>` so the App can be served on the subdomain while the apex stays the landing page. `/api/*` is not rewritten. Hobby `*.vercel.app` hosts are ignored by this rewrite.

## License

[MIT](./LICENSE). Vulnerability reporting: [SECURITY.md](SECURITY.md).

## Hackathon disclosure

Built for the **Colosseum Crypto World's Fair** — entered in the **Solana track**; also applying for the Public Goods Award and University Award.

Original private repository [`truenorth-lj/SoFinance`](https://github.com/truenorth-lj/SoFinance) first commit **2026-09-29** (`chore: scaffold USDC position zap project`, author date `2026-09-29T02:09:15Z`), within the Sep 14–Oct 12 PT hackathon window. This public repository (`truenorth-lj/sofinance-public`) was created **2026-10-06** with a fresh history so hardcoded personal wallet addresses could be removed and documentation published in English. Read access to the original private repo will be granted to `hackathon@colosseum.com` for verification.

Development used the author’s own pre-built generic agent skill (a “research-pipeline” skill) and AI coding assistants as tooling—not pre-hackathon product code.

History sanitized for privacy on 2026-10-12 (author dates preserved; personal email and test-wallet identifiers removed).

## Read-only planning and position performance

`/app/plan` takes an amount and duration, loads the RWA pair catalog and the selected pool's
daily APR through read-only APIs, and projects daily compounding using the best available
7-, 30- or 90-day average over complete UTC days. This shows the optimistic end of recent
history, not a forecast. Loss-alert and exit-asset preferences do not change the projection.
Retired goal-first query parameters (`goal`, `target`, `aim`) are ignored. The independent
`/api/lp-decision` deterministic scenario endpoint remains available; it is not the Plan
page's calculation path.

The Performance tab for a real position (`/app?view=performance&mint=<position NFT mint>`, also reachable from `/app/position-performance`) shows holding time, an estimated trading-fee APR (fees earned so far, annualized; not a forecast or a promised return), the position value split into liquidity and unclaimed fees, and an unsigned, read-only USDC + SOL exit estimate. It reads public pool/position snapshots, raw transactions, USD daily candles and principal-only Jupiter route quotes. The exit estimate is a split-asset simulation, not all-USDC cash and not an executable quote; it runs by itself for a position held by the connected wallet, and otherwise says so and offers a manual preview. Nothing in either page prepares or submits trades. The earlier ledger / history / same-cash-flow HODL comparison (and its `/api/lp-decision/ledger` route) was removed from the product; see [implementation, acceptance and local preview](specs/lp-decision/IMPLEMENTATION.md), whose ledger notes are kept as historical design context. Its notes on the earlier date/amount builder describe the UI that `/app/plan` replaced.

## Engine workspace

`packages/engine` owns transaction builders, quotes, RPC and Jupiter clients. Web/API/MCP
adapters and application policies remain in `src/`. The root pnpm workspace links the engine;
`pnpm test` and `pnpm typecheck` check both app and engine, with separate Vitest configurations.
`e2e/` remains an independent npm package with its own lockfile. Use pnpm at the repository root.

The engine migration preserves the exact 0.1.6 runtime and includes its original tests and
snapshots. See [package documentation](packages/engine/README.md) and
[import provenance](packages/engine/provenance.json). The paused prototype is unchanged.
The engine retains its existing UNLICENSED metadata; the root MIT license does not relicense it.
