# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/). `package.json` is already `0.1.0`.

## [Unreleased]

### Changed

- Open-position signing follows Phantom’s multi-signer recipe: the client generates the position NFT mint, `/api/open-prepare` returns a fully unsigned transaction, the wallet signs first, then the mint signature is added on the wallet-returned tx. MCP agents should pass `nftMint` and mint-sign after the wallet; omitting it keeps an MCP-only server partial-sign for `/app/sign`.
- Wallet-returned transactions are the source of truth. Extra Lighthouse / ComputeBudget instructions from Phantom `signTransaction` are allowed; the fee payer, required signers, and original program instructions must still be present in order. MCP `/app/sign` still requires a byte-identical message.
- Phantom-compatible sanity compares resolved program ids + data + statically resolvable account pubkeys (not raw indexes). ComputeBudget may be added, removed, or rewritten. A mismatch logs a compact program-id diagnostic to the console and Sentry.

### Fixed

- Open / add / compound Jupiter quotes try the keyed server path first and fall back to it when the browser relay hits 429, times out, or is unreachable, instead of failing with "Quote did not settle"
- Persistent browser Jupiter 429s fail-fast (3s wait / 1 retry / 10s fetch; 45s open quote and prepare timeouts) instead of looping 409s, then use that keyed fallback
- Open / add / compound / withdraw fee estimates retry empty or timed-out `getFeeForMessage` results and fail over to the public RPC, then show a clear retryable error
- PostHog events are sent through a first-party relay (`/lumen`, Next.js rewrites) instead of `us.i.posthog.com`, which ad blockers block
- Track `wallet_connect_clicked` and `performance_view` (the Performance tab doesn't change the URL, so it had no pageview)
- Heatmaps, web vitals, and surveys are turned off in the client so remote project settings can't add events beyond the documented list

## [0.1.0] - 2026-10-20

First tagged public release of **SoFinance**: a non-custodial Next.js web app and MCP server for Raydium CLMM strategies on same-asset RWA pairs. Live app: https://sofinancelab.xyz.

Summarized from git history on `main` and the README feature list. Not an audit and not a promise of returns.

### Added

- Shared engine in `src/lib` (also consumed as `@sofinance/engine`) powering both the web API and MCP
- Next.js web app: marketing landing at `/`, product UI under `/app` (Positions, Plan, RWA pairs, position performance, Use AI, sign deep-links)
- MCP server (`src/mcp/`): tools that return **unsigned v0 transactions**; remote HTTP at `/api/mcp` (wallet-bound short-lived tokens, zero local secrets) and local stdio (`pnpm mcp:start`)
- Add-liquidity zap: Jupiter Swap V2 + Raydium `increase_liquidity_v2` in one simulated v0 transaction, with add-liquidity price tolerance and a resale-ratio floor
- One-click compound: harvest fees/rewards, swap to range ratio, reinvest (plus leftover / historical cleanup)
- In-app **open CLMM position** (quote → prepare → sign → submit) with range presets and estimated fee APR; ephemeral NFT mint keypair is partial-signed then zeroed
- Withdraw from a position (USDC, another token, or original tokens)
- Same-asset RWA pair discovery (Jupiter `stocks`/`rwa` tags + Backed xStocks whitelist) with TVL, volume, and estimated fee APR
- Position performance / realized fee APR from on-chain events; token-equivalent metrics for wrap pairs; optional on-demand history persistence
- Optional Solami RPC, Beam tips, and Blur live pool activity
- Optional protocol swap fee (`SOFINANCE_FEE_WALLET`, `SOFINANCE_FEE_BPS`; default 10 bps, max 100; unset wallet = fee 0)
- Safety gates on web and MCP: price-impact cap, 1,232-byte limit, full simulation, HMAC permit, re-verify before broadcast
- Public `/docs` user guide, Plan page (read-only LP decision analysis), official X link
- Optional RWA snapshot service (Drizzle/PostgreSQL) with a `Dockerfile` for that gateway, not the Next.js app
- Optional PostHog product analytics (`NEXT_PUBLIC_POSTHOG_KEY`) and a best-effort Postgres log of confirmed open broadcasts (`SOFINANCE_OPENS_DATABASE_URL`) with an authenticated `GET /api/internal/opens-daily` read path

### Security

- Non-custodial model: the server never holds user keys; users sign every transaction. See [SECURITY.md](SECURITY.md).
