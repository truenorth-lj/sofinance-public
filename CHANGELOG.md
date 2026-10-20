# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project uses [Semantic Versioning](https://semver.org/). `package.json` is already `0.1.0`.

## [0.1.0] - 2026-10-20

First tagged public release of **SoFinance**: a non-custodial Next.js web app and MCP server for Raydium CLMM strategies on same-asset RWA pairs. Live app: https://sofinancelab.xyz.

Summarized from git history on `main` and the README feature list. Not an audit and not a promise of returns.

### Added

- Shared engine in `src/lib` plus the bundled `@sofinance/engine` package (not MIT-licensed) powering both the web API and MCP
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

### Security

- Non-custodial model: the server never holds user keys; users sign every transaction, verifiable on Solscan. See [SECURITY.md](SECURITY.md).
