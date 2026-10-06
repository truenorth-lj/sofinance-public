#!/usr/bin/env node
// Must stay the first import: lets the Next.js "server-only" guard load in a
// plain Node process, so `npx tsx src/mcp/server.ts` works without NODE_OPTIONS.
import "./server-only-mock.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
  listRwaPairsSchema,
} from "./schemas.js";
import {
  listPositions,
  quoteAddLiquidity,
  prepareTransaction,
  quoteCompound,
  prepareCompoundTransaction,
  submitSignedTransaction,
  submitCompoundTransaction,
  listRwaPairs,
} from "./tools.js";

/**
 * SoFinance MCP Server
 * 
 * Provides AI agents with tools to manage Solana Raydium CLMM positions:
 * - Discover positions and assets
 * - Quote and prepare add-liquidity transactions
 * - Quote and prepare compound (yield reinvestment) transactions
 * - Submit signed transactions with full re-verification
 * 
 * Safety: Server never holds private keys. All transactions are:
 * - Fully simulated before preparation
 * - Protected by HMAC permits
 * - Re-verified immediately before broadcast
 * - Subject to 1232-byte limit and price impact caps
 */

const server = new Server(
  {
    name: "sofinance-mcp-server",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Tool definitions with comprehensive descriptions
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [

      {
        name: "list_rwa_pairs",
        description:
          "Discover Raydium CLMM pools where BOTH sides are the same underlying RWA asset (wrapped vs unwrapped / xStock style), e.g. SPCXx/SPCX, MSTRx/MSTR, NVDAx/NVDA. Excludes RWA/USDC and unrelated meme collisions. Returns pool address, mint symbols, fee tier, TVL, 24h volume/fees, Raydium fee APR, estimated fee APR from (24h fees/TVL)*365*100 (labeled), Token-2022 and freeze-risk flags. Read-only; no wallet required. Pairing rule: FOOx/FOO (or FOO-x / xFOO) symbol wrap + xStock/Backpack/tokenized naming evidence + related counterparty name.",
        inputSchema: {
          type: "object",
          properties: {
            minTvl: {
              type: "number",
              description: "Minimum pool TVL in USD (default 0)",
              default: 0,
            },
            maxPages: {
              type: "number",
              description: "Max Raydium list pages to scan, page size 1000 (1-30, default 10)",
              default: 10,
            },
            sortBy: {
              type: "string",
              enum: ["estimatedFeeApr", "tvl", "volume24h"],
              description:
                "Sort key. estimatedFeeApr uses (24h fees/TVL)*365*100 when available; also returns raydiumFeeApr24h from the API.",
              default: "estimatedFeeApr",
            },
          },
          required: [],
        },
      },
      {
        name: "list_positions",
        description:
          "List all Raydium CLMM positions and wallet assets. Returns position NFTs (with pool, ticks, liquidity) and eligible input assets (SOL, tokens) with balances. Read-only, no private keys required. Use this first to discover available positions and assets.",
        inputSchema: {
          type: "object",
          properties: {
            wallet: {
              type: "string",
              description: "Solana wallet public key (base58, 32-44 chars)",
            },
          },
          required: ["wallet"],
        },
      },
      {
        name: "quote_add_liquidity",
        description:
          "Get a quote for adding liquidity to a position. Estimates swap routes (Jupiter), price impact, output amounts, and immediate resale gap. Verifies NFT ownership, pool state, and balance. Read-only. Quotes expire quickly (configured TTL). Failure modes: insufficient balance, high price impact (>5%), resale floor breach, quote expiration, pool state changes.",
        inputSchema: {
          type: "object",
          properties: {
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            positionMint: {
              type: "string",
              description: "Position NFT mint address (from list_positions)",
            },
            inputMint: {
              type: "string",
              description: "Input asset mint address (from list_positions assets)",
            },
            inputKind: {
              type: "string",
              enum: ["native", "token"],
              description: "Asset kind: 'native' for SOL, 'token' for SPL tokens",
            },
            amount: {
              type: "string",
              description: "Amount in token units (e.g. '1.5' for 1.5 SOL)",
            },
            resaleFloorBps: {
              type: "number",
              description:
                "Minimum resale ratio in basis points (9500-10000, default 9900 = 1% max loss). Conservative immediate-resale protection.",
              default: 9900,
            },
            slippageToleranceBps: {
              type: "number",
              description:
                "Add-liquidity price tolerance in basis points (0-500, multiple of 10, default 100 = 1%). Liquidity is sized so the pool price may drift this much before execution; the unused reserve stays in the wallet. Jupiter swap slippage stays fixed at 0.5%.",
              default: 100,
            },
          },
          required: ["wallet", "positionMint", "inputMint", "inputKind", "amount"],
        },
      },
      {
        name: "prepare_transaction",
        description:
          "Prepare an unsigned, fully-simulated transaction for adding liquidity. Returns base64-encoded transaction for signing, HMAC permit, and summary. The server NEVER holds private keys. Transaction must be signed by the user/agent wallet. Includes: full simulation, 1232-byte limit check, Jupiter swap + Raydium increase_liquidity_v2, short-lived permit. Failure modes: same as quote_add_liquidity, plus simulation failure, size limit, blockhash expiry. After signing, use submit_signed_transaction.",
        inputSchema: {
          type: "object",
          properties: {
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            positionMint: {
              type: "string",
              description: "Position NFT mint address",
            },
            inputMint: {
              type: "string",
              description: "Input asset mint address",
            },
            inputKind: {
              type: "string",
              enum: ["native", "token"],
              description: "Asset kind: 'native' or 'token'",
            },
            amount: {
              type: "string",
              description: "Amount in token units",
            },
            resaleFloorBps: {
              type: "number",
              description: "Resale floor in basis points (9500-10000, default 9900)",
              default: 9900,
            },
            slippageToleranceBps: {
              type: "number",
              description:
                "Add-liquidity price tolerance in basis points (0-500, multiple of 10, default 100)",
              default: 100,
            },
          },
          required: ["wallet", "positionMint", "inputMint", "inputKind", "amount"],
        },
      },
      {
        name: "quote_compound",
        description:
          "Get a quote for compounding a position (harvest fees/rewards, swap to ratio, reinvest). Returns expected liquidity increase, swap plan, simulation results. Verifies position eligibility. Read-only. Phase one: rejects third reward tokens (no verifiable swap path). Failure modes: ineligible position, third reward token, insufficient yield for minimum liquidity unit, swap plan failure.",
        inputSchema: {
          type: "object",
          properties: {
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            positionMint: {
              type: "string",
              description: "Position NFT mint address",
            },
            sourceSignatures: {
              type: "array",
              items: { type: "string" },
              description:
                "Optional: prior yield transaction signatures to merge (max 3)",
              maxItems: 3,
            },
          },
          required: ["wallet", "positionMint"],
        },
      },
      {
        name: "prepare_compound_transaction",
        description:
          "Prepare an unsigned compound transaction. Returns base64 transaction, permit, and summary. Same safety as prepare_transaction: full simulation, HMAC permit, no private keys. After signing, use submit_compound_transaction.",
        inputSchema: {
          type: "object",
          properties: {
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            positionMint: {
              type: "string",
              description: "Position NFT mint address",
            },
            sourceSignatures: {
              type: "array",
              items: { type: "string" },
              description: "Optional: prior yield signatures (max 3)",
              maxItems: 3,
            },
          },
          required: ["wallet", "positionMint"],
        },
      },
      {
        name: "submit_signed_transaction",
        description:
          "Submit a signed add-liquidity transaction. Re-verifies HMAC permit, re-reads on-chain state, re-simulates, then broadcasts. Pass signedTransaction plus every field of submitArgs from the prepare_transaction response, unchanged. Failure modes: permit mismatch, state changed (liquidity, balance, NFT), expired (time or blockhash), simulation failure. Returns transaction signature on success.",
        inputSchema: {
          type: "object",
          properties: {
            signedTransaction: {
              type: "string",
              description: "Base64-encoded signed transaction",
            },
            permit: {
              type: "string",
              description: "HMAC permit from prepare_transaction",
            },
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            selection: {
              type: "object",
              properties: {
                positionMint: { type: "string" },
                inputMint: { type: "string" },
                inputKind: { type: "string", enum: ["native", "token"] },
              },
              required: ["positionMint", "inputMint", "inputKind"],
            },
            requested: {
              type: "string",
              description: "Requested amount from summary",
            },
            expectedLiquidity: {
              type: "string",
              description: "Expected liquidity from summary",
            },
            startingLiquidity: {
              type: "string",
              description: "Starting liquidity from summary",
            },
            floorBps: {
              type: "number",
              description: "Resale floor basis points",
            },
            expiresAt: {
              type: "number",
              description: "Expiry timestamp (ms) from summary",
            },
            lastValidBlockHeight: {
              type: "number",
              description: "Block height from summary",
            },
            rangeSide: {
              type: "string",
              enum: ["below", "inside", "above"],
              description: "Position range side from summary",
            },
            startingBalances: {
              type: "object",
              properties: {
                input: { type: "string" },
                a: { type: "string" },
                b: { type: "string" },
              },
              required: ["input", "a", "b"],
            },
          },
          required: [
            "signedTransaction",
            "permit",
            "wallet",
            "selection",
            "requested",
            "expectedLiquidity",
            "startingLiquidity",
            "floorBps",
            "expiresAt",
            "lastValidBlockHeight",
            "rangeSide",
            "startingBalances",
          ],
        },
      },
      {
        name: "submit_compound_transaction",
        description:
          "Submit a signed compound transaction. Re-verifies permit and summary, then broadcasts. Returns signature on success. Same safety as submit_signed_transaction.",
        inputSchema: {
          type: "object",
          properties: {
            signedTransaction: {
              type: "string",
              description: "Base64-encoded signed transaction",
            },
            permit: {
              type: "string",
              description: "HMAC permit from prepare_compound_transaction",
            },
            wallet: {
              type: "string",
              description: "Wallet public key",
            },
            summary: {
              type: "object",
              description:
                "Complete summary object from prepare_compound_transaction response, unchanged (bound by the permit)",
            },
          },
          required: ["signedTransaction", "permit", "wallet", "summary"],
        },
      },
    ],
  };
});

// Tool execution handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {

      case "list_rwa_pairs": {
        const input = listRwaPairsSchema.parse(args ?? {});
        const result = await listRwaPairs(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
      case "list_positions": {
        const input = listPositionsSchema.parse(args);
        const result = await listPositions(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "quote_add_liquidity": {
        const input = quoteAddLiquiditySchema.parse(args);
        const result = await quoteAddLiquidity(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "prepare_transaction": {
        const input = prepareTransactionSchema.parse(args);
        const result = await prepareTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "quote_compound": {
        const input = quoteCompoundSchema.parse(args);
        const result = await quoteCompound(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "prepare_compound_transaction": {
        const input = quoteCompoundSchema.parse(args);
        const result = await prepareCompoundTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "submit_signed_transaction": {
        const input = submitSignedTransactionSchema.parse(args);
        const result = await submitSignedTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "submit_compound_transaction": {
        const input = submitCompoundTransactionSchema.parse(args);
        const result = await submitCompoundTransaction(input);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  // Log to stderr (stdout is reserved for MCP protocol)
  // eslint-disable-next-line no-console
  console.error("SoFinance MCP server running on stdio");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", error);
  process.exit(1);
});
