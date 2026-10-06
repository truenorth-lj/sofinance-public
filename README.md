# SoFinance

A Solana DeFi application for managing Raydium CLMM liquidity positions with automated yield compounding and position rebalancing.

## Overview

After connecting a Solana wallet, the website scans for **Raydium CLMM position NFTs**, SPL Token/Token-2022 ATA assets, and native SOL held by the wallet. Users select a target position, input assets, and amount; the website re-verifies on-chain NFT, pool, ticks, mint, balance, and routing, estimates the ratio for immediately swapping back to **the same input asset** after adding liquidity, then composes Jupiter swap and Raydium increase_liquidity into a single v0 transaction with full simulation. The first version only supports Raydium CLMM NFTs directly held by wallets, not staked positions, Orca, or Meteora.

## Local Development

```bash
pnpm install
cp .env.example .env.local
# Set SOLANA_RPC_URL, JUPITER_API_KEY, NEXT_PUBLIC_REOWN_PROJECT_ID in .env.local
pnpm dev --webpack --hostname 127.0.0.1
```

`--webpack` is suitable for development worktrees sharing `node_modules` via symlinks; Turbopack may refuse links outside the worktree. `SOLANA_RPC_URL` and `JUPITER_API_KEY` are server-only; do NOT prefix them with `NEXT_PUBLIC_*`. Reown Project ID can be public. If you set `NEXT_PUBLIC_SOLANA_RPC_URL`, only use a browser-visible endpoint without private credentials. `.env.local` is excluded by `.gitignore`; never put mnemonics, private keys, or API keys into source code, logs, chat, or commits.

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Features

### Position Selection & Asset Management
- Automatically discovers Raydium CLMM positions held by your wallet
- Scans for Token and Token-2022 assets with full support for associated token accounts (ATAs)
- Displays position details including price range, current tick, and pool information
- Shows token metadata from Jupiter API with icons, symbols, and verification badges

### Quote & Protection
- After entering an amount or adjusting the resale gap, the interface automatically fetches quotes with full transaction checks about 450ms after you stop typing
- Auto-refreshes when quotes expire
- Click "Sign and Submit Complete Transaction" once to re-prepare the latest transaction for wallet confirmation
- If quotes or checks fail, adjust inputs or click "Recalculate"

### Safety Mechanisms
- `/api/wallet` scans Token and Token-2022 accounts separately using server RPC, derives Raydium CLMM personal-position PDAs from NFT mints with amount=1, verifies position and pool programs and data
- Only balances in associated token accounts (ATAs) can be selected as SPL inputs; other token account balances are listed separately as total wallet holdings
- NFTs, frozen/paused/transfer-fee, or unsupported extension settings display reasons and disable actions
- `/api/selected-state`, `/api/selected-quote`, and `/api/selected-preflight` do not trust the frontend list; each time they re-verify NFT ownership, PDA, pool, both tokens, vault, ticks, token program, and asset balance
- Stops if Jupiter `/swap/v2/build` has no route, price impact too high, crosses active tick, transaction exceeds 1,232 bytes, or full simulation fails

### Smart Routing
- If the input asset is one of the pool's tokens, that portion goes directly in; the remainder swaps
- Native SOL and WSOL tokens are handled per source, native SOL reserves at least 0.01 SOL
- Simulation additionally restricts fees and ATA rent
- When there's existing WSOL ATA balance, native SOL path conservatively refuses to avoid Jupiter cleanup using existing WSOL

### Resale Protection
- "Maximum Estimated Immediate Resale Gap" defaults to 1%, adjustable 0–5%
- Compares a conservative quote for swapping the two tokens needed for adding liquidity back to **the original input asset** immediately
- Not USD valuation, actual realized loss, or future value guarantee
- Jupiter slippage is fixed at 0.5%, price impact cap 5%
- SOL network fees and possible ATA rent are calculated separately

### Transaction Flow
- After full simulation passes, `/api/selected-prepare` prepares wallet signature
- Preparation re-quotes and simulates; short-lived HMAC permit binds complete transaction message, wallet, input mint/kind, position, amount, threshold, and initial state
- After signing, `/api/selected-broadcast` re-verifies signature, re-reads state, re-simulates, then submits via server RPC
- Browser saves signature and selection before broadcast
- After refresh, `/api/selected-status` uses the transaction's Raydium `increase_liquidity_v2` precise liquidity parameter to verify the same NFT

### Yield Compounding
- One-click compound feature to harvest fees and reinvest them back into the position
- Automatically swaps harvested fees to match the required ratio for the position's price range
- Handles both pool tokens and additional reward tokens
- Full simulation and verification before execution

## Testing & Verification

Local tests exist for:
- Empty wallet scenarios
- Multiple positions
- Multiple accounts per mint
- Direct pool asset input
- Precision handling
- Permit generation
- Simulation read-back
- Desktop/mobile page functionality without connected wallet

Real on-chain data testing showed successful wallet scanning, state reading, and full read-only atomic simulation for various token combinations (typical transactions: 1,205 bytes, 147,989 CU). The system includes safeguards that reject transactions exceeding 1,232 bytes during preflight checks.

These results represent specific test moments; Raydium SDK and Jupiter instructions may encounter compatibility issues due to pool configuration, token extension settings, ATA state, or route size. Always verify wallet, input asset, position NFT, direction, amount, and approximate value before signing; the program will re-simulate completely before execution.

## Architecture

- **Frontend**: Next.js 16 App Router with React 19 and TypeScript
- **Styling**: Tailwind CSS with custom components
- **Wallet**: Solana Wallet Adapter + Reown AppKit for mobile support
- **DeFi Integration**: 
  - Raydium SDK v2 for CLMM position management
  - Jupiter Swap V2 for optimal routing
  - @solana/web3.js for on-chain interactions
- **State Management**: React hooks with local storage for transaction recovery

## Security Notes

- All RPC endpoints and API keys must be configured via environment variables
- Server-only secrets never exposed to the browser
- Full simulation required before any transaction
- HMAC-protected transaction permits with short TTL
- Position and balance verification at every step
- Conservative resale gap protection to prevent unexpected losses
