# SoFinance MCP Server - Implementation Summary

## Overview

Successfully added a minimal, production-ready MCP (Model Context Protocol) server to SoFinance that allows AI agents (Claude Desktop, Cursor, etc.) to manage Raydium CLMM positions with the same safety guarantees as the web UI.

## What Was Built

### 1. MCP Server Architecture (`src/mcp/`)

**Files Created:**
- `server.ts` - Main MCP server with stdio transport (444 lines)
- `tools.ts` - Tool implementations reusing existing lib/ logic (470 lines)
- `schemas.ts` - Zod schemas for input validation (79 lines)
- `schemas.test.ts` - Schema validation tests (168 lines)
- `tools.test.ts` - Tool implementation tests (348 lines)
- `index.ts` - Entry point
- `server-only-mock.js` - Mock for Next.js server-only package
- `server-only-mock-impl.js` - Empty module for mock

**Total:** ~1,600 lines of new code

### 2. MCP Tools (7 total)

| Tool | Type | Description |
|------|------|-------------|
| `list_positions` | Read-only | Discover wallet positions and assets |
| `quote_add_liquidity` | Read-only | Get swap routes and price estimates |
| `prepare_transaction` | Prepare | Build unsigned, simulated transaction |
| `quote_compound` | Read-only | Quote yield harvesting and reinvestment |
| `prepare_compound_transaction` | Prepare | Build unsigned compound transaction |
| `submit_signed_transaction` | Broadcast | Re-verify and broadcast signed transaction |
| `submit_compound_transaction` | Broadcast | Re-verify and broadcast compound transaction |

### 3. Safety Guarantees (unchanged from web UI)

✅ Server **never holds private keys**  
✅ **Full simulation** before preparation  
✅ **HMAC permits** bind transactions to verified state  
✅ **Re-verification** before broadcast  
✅ **1232-byte limit** hard cap  
✅ **Price impact cap** (5%)  
✅ **Resale protection** (0-5% configurable)  
✅ **NFT ownership** verified at every step  

### 4. Testing & Validation

- **30 new unit tests** (all passing)
- **127 total tests** (all passing)
- **Lint** ✅ (0 warnings)
- **Typecheck** ✅ (no errors)
- **Build** ✅ (production ready)

### 5. Documentation

**README.md** - Added comprehensive "Use with AI Agents (MCP)" section:
- Quick start guide
- Claude Desktop configuration
- Cursor configuration
- Available tools table
- Example 5-step agent walkthrough
- Safety guarantees
- Failure modes
- Testing instructions
- Limitations
- 3-minute demo outline

### 6. Dependencies Added

```json
{
  "@modelcontextprotocol/sdk": "1.32.1",
  "tsx": "4.23.15",
  "zod": "4.6.5",
  "server-only": "0.0.1"
}
```

## How to Run

### Quick Start

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env.local
# Edit .env.local and set:
#   SOLANA_RPC_URL=your-solana-rpc-url
#   JUPITER_API_KEY=your-jupiter-api-key

# Run MCP server
pnpm mcp:start

# Or in watch mode for development
pnpm mcp:dev
```

### Claude Desktop Integration

1. Open `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Add:

```json
{
  "mcpServers": {
    "sofinance": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/sofinance/src/mcp/server.ts"],
      "env": {
        "SOLANA_RPC_URL": "your-rpc-url",
        "JUPITER_API_KEY": "your-api-key"
      }
    }
  }
}
```

3. Restart Claude Desktop
4. Look for "sofinance" in the available MCP servers

### Cursor Integration

Add to Cursor MCP settings:

```json
{
  "sofinance": {
    "command": "pnpm",
    "args": ["mcp:start"],
    "cwd": "/absolute/path/to/sofinance",
    "env": {
      "SOLANA_RPC_URL": "your-rpc-url",
      "JUPITER_API_KEY": "your-api-key"
    }
  }
}
```

## Example Agent Walkthrough

### Step 1: Discover Positions

```typescript
// Agent calls
listPositions({ wallet: "YourWalletPublicKey" })

// Returns
{
  wallet: "...",
  positions: [
    {
      positionMint: "...",
      poolId: "...",
      mintA: "So11111111111111111111111111111111111111112",
      mintB: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      rangeSide: "inside",
      liquidity: "1000000",
      ...
    }
  ],
  assets: [
    {
      kind: "native",
      mint: "So11111111111111111111111111111111111111112",
      balance: "1500000000", // 1.5 SOL
      eligible: true
    }
  ]
}
```

### Step 2: Get Quote

```typescript
// Agent calls
quoteAddLiquidity({
  wallet: "YourWalletPublicKey",
  positionMint: "PositionNFTMint",
  inputMint: "So11111111111111111111111111111111111111112",
  inputKind: "native",
  amount: "1.0",
  resaleFloorBps: 9900 // 1% max loss
})

// Returns
{
  requested: "1000000000",
  liquidity: "950000",
  minOutA: "495000000",
  minOutB: "495000000",
  resaleInput: "990000000", // Immediate resale would get 0.99 SOL back
  passesFloor: true,
  maxImpactBps: 500, // 5% cap
  ...
}
```

### Step 3: Prepare Transaction

```typescript
// Agent calls
prepareTransaction({
  wallet: "YourWalletPublicKey",
  positionMint: "PositionNFTMint",
  inputMint: "So11111111111111111111111111111111111111112",
  inputKind: "native",
  amount: "1.0",
  resaleFloorBps: 9900
})

// Returns
{
  unsignedTransaction: "base64-encoded-transaction",
  permit: "hmac-permit-string",
  summary: {
    simulated: true,
    sizeBytes: 1205,
    unitsConsumed: 147989,
    feeLamports: 5000,
    expiresAt: 1234567890000,
    lastValidBlockHeight: 1000000,
    ...
  },
  instructions: {
    message: "Sign the unsignedTransaction...",
    requiredForSubmit: [...]
  }
}
```

### Step 4: Sign Transaction

**User/agent signs the transaction client-side with their wallet.**

Options:
- Solana CLI: `solana sign transaction.json`
- Wallet adapter in custom code
- Hardware wallet
- Agent with secure key management

The MCP server never sees or holds private keys.

### Step 5: Submit Signed Transaction

```typescript
// Agent calls
submitSignedTransaction({
  signedTransaction: "base64-signed-transaction",
  permit: "permit-from-prepare",
  wallet: "YourWalletPublicKey",
  selection: { positionMint, inputMint, inputKind },
  requested: "1000000000",
  expectedLiquidity: "950000",
  startingLiquidity: "900000",
  floorBps: 9900,
  expiresAt: 1234567890000,
  lastValidBlockHeight: 1000000,
  rangeSide: "inside",
  startingBalances: { input: "...", a: "...", b: "..." }
})

// Server:
// 1. Verifies HMAC permit
// 2. Re-reads on-chain state
// 3. Re-simulates transaction
// 4. Broadcasts if all checks pass

// Returns
{
  signature: "5J8H5sTvEhn..."
}
```

## Technical Implementation Details

### 1. Architecture Choices

**Reuse over Duplication**
- MCP tools call existing `lib/` functions directly
- No logic duplication - same safety gates as web UI
- Minimal adapter layer (tools.ts)

**Type Safety**
- Zod schemas for all inputs
- TypeScript throughout
- Validated at runtime

**Standalone Execution**
- Handles Next.js `server-only` package via mock
- Runs as pure Node.js process
- No Next.js runtime required

### 2. Safety Architecture

```
MCP Tool Call
    ↓
Input Validation (Zod)
    ↓
Existing Lib Function
    ↓
On-chain Verification (RPC)
    ↓
Full Simulation
    ↓
HMAC Permit Generation
    ↓
Return to Agent
    ↓
[User Signs Transaction]
    ↓
Permit Verification
    ↓
Re-read State
    ↓
Re-simulate
    ↓
Broadcast (if all checks pass)
```

### 3. Error Handling

All tools fail fast with clear error messages:

- **Insufficient balance**: "Insufficient input asset balance or SOL reserve"
- **High price impact**: "Price impact relative to probe route exceeds 5% limit"
- **Resale floor breach**: "Conservative immediate resale ratio below selected threshold"
- **Size limit**: "Complete swap + add transaction exceeds 1,232 byte limit"
- **Expired**: "Quote expired, please resimulate"
- **State changed**: "Position, liquidity, or wallet balance has changed since preparation"

## Limitations

### Phase One Constraints

1. **Third reward tokens** - Rejected (no verifiable swap path for full reinvestment)
2. **Direct positions only** - Raydium CLMM only (no Orca, Meteora, staked positions)
3. **ATA only** - Only associated token account balances eligible (security)
4. **Quote expiry** - Agents must prepare and sign promptly (configurable TTL)
5. **Single signer** - No multi-sig support

### Future Enhancements

- Support for Orca and Meteora pools
- Multi-sig transaction support
- Longer-lived permits with refresh
- Batch operations (multiple positions at once)
- Position rebalancing tools
- Historical analytics tools

## Testing

### Run Tests

```bash
# All tests
pnpm test

# MCP tests only
pnpm test src/mcp

# With coverage
pnpm test --coverage
```

### Test with Mock Wallet (Safe)

```bash
# In one terminal
pnpm mcp:start

# In another terminal, use Claude Desktop or Cursor with the MCP server configured
# Use a devnet wallet to test with real on-chain data (no real value at risk)
```

### Integration Testing

For full integration testing:
1. Configure `SOLANA_RPC_URL` to point to devnet
2. Use a devnet wallet with test SOL
3. Test full flow: list → quote → prepare → sign → submit
4. Verify transaction on Solana Explorer (devnet)

## Hackathon Submission

### Pitch

"DeFi LP strategies usable by both humans (existing web UI) and AI agents (new MCP server)"

### Demo Topics (3 minutes)

1. **Discover** (15s): Agent lists wallet positions and assets
2. **Quote** (30s): Agent gets quote for adding 1 SOL to a position
3. **Prepare** (30s): Agent prepares transaction, shows unsigned tx and permit
4. **Sign** (30s): User signs transaction (simulated/mocked for demo)
5. **Submit** (30s): Agent submits, shows re-verification steps
6. **Compound** (45s): Agent quotes and prepares compound transaction
7. **Error handling** (30s): Agent handles insufficient balance, expired quote

### Deadline

**Oct 13, 2026 14:59 Asia/Taipei**

## Pull Request

**URL**: https://github.com/truenorth-lj/sofinance-public/pull/1  
**Status**: Draft (ready for review)  
**Branch**: `cursor/mcp-server-b78f`  

### Checklist

- ✅ MCP server builds and runs
- ✅ Unit tests cover each tool (30 tests)
- ✅ Existing lint/typecheck/tests/build still pass
- ✅ README has 'Use with AI agents (MCP)' section
- ✅ Claude Desktop/Cursor config snippets
- ✅ Example agent walkthrough
- ✅ All text in English
- ✅ No personal wallet addresses
- ✅ Suitable for 3-minute demo video

## Conclusion

Successfully delivered a production-ready MCP server that:

1. ✅ **Builds and runs** over stdio
2. ✅ **Reuses existing logic** (no duplication)
3. ✅ **Maintains safety** (same guarantees as web UI)
4. ✅ **Well-tested** (30 new tests, all passing)
5. ✅ **Well-documented** (comprehensive README section)
6. ✅ **Demo-ready** (3-minute outline included)
7. ✅ **Hackathon-ready** (deadline: Oct 13, 2026)

The MCP server makes SoFinance's Raydium CLMM position management accessible to AI agents while preserving the critical safety mechanisms that protect users from unexpected losses, high price impact, and other DeFi risks.
