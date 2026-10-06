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

## Use with AI Agents (MCP)

SoFinance provides an MCP (Model Context Protocol) server that allows AI agents like Claude Desktop or Cursor to discover positions, quote liquidity additions, prepare transactions, and submit them—all with the same safety guarantees as the web UI.

### Quick Start

**1. Install and configure:**

```bash
# Clone and install
git clone https://github.com/yourusername/sofinance.git
cd sofinance
pnpm install

# Configure environment
cp .env.example .env.local
# Set SOLANA_RPC_URL and JUPITER_API_KEY in .env.local
```

`JUPITER_API_KEY` is required for quotes and also serves as the server-side HMAC key for transaction permits, so `quote_add_liquidity` and all `prepare_*`/`submit_*` tools fail without it. `list_positions` and `quote_compound` only need `SOLANA_RPC_URL`. For compound, pass the complete `summary` from `prepare_compound_transaction` back to `submit_compound_transaction` unchanged.

**2. Run the MCP server:**

```bash
pnpm mcp:start
```

Or use `npx` directly:

```bash
npx tsx src/mcp/server.ts
```

### Claude Desktop Configuration

Add to your `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "sofinance": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/sofinance/src/mcp/server.ts"],
      "env": {
        "SOLANA_RPC_URL": "your-solana-rpc-url",
        "JUPITER_API_KEY": "your-jupiter-api-key"
      }
    }
  }
}
```

Replace `/absolute/path/to/sofinance` with your actual path.

### Cursor Configuration

Add to your Cursor MCP settings:

```json
{
  "sofinance": {
    "command": "pnpm",
    "args": ["mcp:start"],
    "cwd": "/absolute/path/to/sofinance",
    "env": {
      "SOLANA_RPC_URL": "your-solana-rpc-url",
      "JUPITER_API_KEY": "your-jupiter-api-key"
    }
  }
}
```

### Available MCP Tools

| Tool | Description | Safety |
|------|-------------|--------|
| `list_positions` | Discover wallet positions and assets | Read-only, no keys |
| `quote_add_liquidity` | Get swap routes and price estimates | Read-only, full verification |
| `prepare_transaction` | Build unsigned transaction with HMAC permit | Server never holds keys |
| `quote_compound` | Quote yield harvesting and reinvestment | Read-only, simulated |
| `prepare_compound_transaction` | Build unsigned compound transaction | Server never holds keys |
| `submit_signed_transaction` | Re-verify and broadcast signed transaction | Full re-simulation |
| `submit_compound_transaction` | Re-verify and broadcast compound transaction | Full re-simulation |

### Example Agent Walkthrough

**Step 1: List positions**

Agent calls `list_positions` with a wallet address:

```json
{
  "wallet": "YourWalletPublicKey"
}
```

Returns all Raydium CLMM position NFTs and eligible assets (SOL, tokens) with balances.

**Step 2: Quote adding liquidity**

Agent calls `quote_add_liquidity`:

```json
{
  "wallet": "YourWalletPublicKey",
  "positionMint": "PositionNFTMint",
  "inputMint": "So11111111111111111111111111111111111111112",
  "inputKind": "native",
  "amount": "1.5",
  "resaleFloorBps": 9900,
  "slippageToleranceBps": 100
}
```

`slippageToleranceBps` (optional, 0-500 in steps of 10, default 100 = 1%) is the add-liquidity price tolerance: liquidity is sized about 1% below the guaranteed swap outputs and the Raydium `amountMax` values are padded by the same tolerance (never above those outputs), so pool price drift between quote and execution does not trip Raydium's `PriceSlippageCheck` (6017). The unused reserve stays in the wallet as pool assets and still counts toward the resale ratio. Jupiter swap slippage remains fixed at 0.5%.

Returns quote with swap routes, price impact, estimated outputs, and resale protection check.

**Step 3: Prepare transaction**

Agent calls `prepare_transaction` with same parameters:

```json
{
  "wallet": "YourWalletPublicKey",
  "positionMint": "PositionNFTMint",
  "inputMint": "So11111111111111111111111111111111111111112",
  "inputKind": "native",
  "amount": "1.5",
  "resaleFloorBps": 9900
}
```

Returns:
- `unsignedTransaction`: Base64-encoded transaction for signing
- `permit`: HMAC permit binding transaction to verified state
- `submitArgs`: Every permit-bound field `submit_signed_transaction` needs (pass back unchanged)
- `summary`: Transaction details and expiry
- `instructions`: How to submit

**Step 4: Sign transaction**

**User/agent signs the transaction with their wallet.** The MCP server never has access to private keys. Signing happens client-side via:
- Solana CLI: `solana sign <transaction-file>`
- Wallet adapter in custom code
- Hardware wallet
- Agent with secure key management

**Step 5: Submit signed transaction**

Agent calls `submit_signed_transaction` with `{ signedTransaction, ...submitArgs }`, i.e.:

```json
{
  "signedTransaction": "base64-signed-transaction",
  "permit": "permit-from-step-3",
  "wallet": "YourWalletPublicKey",
  "selection": {
    "positionMint": "PositionNFTMint",
    "inputMint": "So11111111111111111111111111111111111111112",
    "inputKind": "native"
  },
  "requested": "1500000000",
  "expectedLiquidity": "1000000",
  "startingLiquidity": "900000",
  "floorBps": 9900,
  "expiresAt": 1234567890000,
  "lastValidBlockHeight": 1000000,
  "rangeSide": "inside",
  "startingBalances": {
    "input": "5000000000",
    "a": "1000000",
    "b": "2000000"
  }
}
```

The server:
1. Verifies HMAC permit
2. Re-reads on-chain state
3. Re-simulates transaction
4. Broadcasts if all checks pass

Returns transaction signature on success.

### Safety Guarantees

All MCP tools enforce the same safety gates as the web UI:

- **NFT Verification**: Every operation re-verifies position NFT ownership
- **Balance Checks**: Confirms sufficient balance before preparation
- **Price Impact Caps**: Rejects swaps exceeding 5% impact
- **Resale Protection**: Conservative immediate-resale gap (default 1%, configurable 0-5%)
- **Transaction Size**: Hard 1,232-byte limit
- **Full Simulation**: Every transaction simulated before and after signing
- **HMAC Permits**: Short-lived permits bind transactions to verified state
- **Re-verification**: State, balances, and liquidity re-checked before broadcast
- **Expiry Checks**: Transactions expire quickly (configurable TTL)

### Failure Modes

Tools fail fast with clear error messages:

- **Insufficient balance**: "Insufficient input asset balance or SOL reserve"
- **High price impact**: "Price impact relative to probe route exceeds 5% limit"
- **Resale floor breach**: "Conservative immediate resale ratio below selected threshold"
- **Size limit**: "Complete swap + add transaction exceeds 1,232 byte limit"
- **Expired**: "Quote expired, please resimulate" or "Transaction blockhash expired"
- **State changed**: "Position, liquidity, or wallet balance has changed since preparation"
- **Third reward token**: "This position has a third reward token; no verifiable isolated swap path available"

### Testing the MCP Server

Run unit tests:

```bash
pnpm test src/mcp
```

Test with a mock wallet (safe, no real transactions):

```bash
# In one terminal
pnpm mcp:start

# In another terminal, use Claude Desktop or Cursor with the MCP server configured
```

For full integration testing with real on-chain data, use a devnet wallet and configure `SOLANA_RPC_URL` to point to devnet.

### Limitations

- **Phase one**: Rejects positions with third reward tokens (no verifiable swap path for full yield reinvestment)
- **Direct positions only**: Does not support staked positions, Orca, or Meteora (Raydium CLMM only)
- **Associated token accounts**: Only ATA balances are eligible as input (for security)
- **Quote expiry**: Quotes and transactions expire quickly; agents must prepare and sign promptly
- **No multi-sig**: Single-signer transactions only (1 required signature)

### Development

Run the MCP server in watch mode for development:

```bash
pnpm mcp:dev
```

Lint and typecheck MCP code:

```bash
pnpm lint
pnpm typecheck
```

### Demo Video Topics

A 3-minute demo might show:

1. **Discover** (15s): Agent lists wallet positions and assets
2. **Quote** (30s): Agent gets quote for adding 1 SOL to a position, shows price impact and resale protection
3. **Prepare** (30s): Agent prepares transaction, shows unsigned transaction and permit
4. **Sign** (30s): User signs transaction (simulated/mocked for demo)
5. **Submit** (30s): Agent submits signed transaction, shows re-verification steps
6. **Compound** (45s): Agent quotes and prepares compound transaction, shows harvest + swap + reinvest
7. **Error handling** (30s): Agent handles insufficient balance, expired quote, state change

Total: ~3 minutes with smooth narration
