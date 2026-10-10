import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp-auth";
import {
  listPositions,
  quoteAddLiquidity,
  prepareTransaction,
  quoteCompound,
  prepareCompoundTransaction,
  submitSignedTransaction,
  submitCompoundTransaction,
  listRwaPairs,
  getPositionPerformance,
  getPoolActivity,
  getPositionRangeStatus,
  quoteOpenPosition,
  prepareOpenPosition,
  submitOpenPosition,
} from "@/mcp/tools";
import {
  listPositionsSchema,
  quoteAddLiquiditySchema,
  prepareTransactionSchema,
  quoteCompoundSchema,
  submitSignedTransactionSchema,
  submitCompoundTransactionSchema,
  listRwaPairsSchema,
  getPositionPerformanceSchema,
  getPoolActivitySchema,
  getPositionRangeStatusSchema,
  quoteOpenPositionSchema,
  prepareOpenPositionSchema,
  submitOpenPositionSchema,
} from "@/mcp/schemas";

/**
 * POST /api/mcp
 * 
 * Remote MCP-over-HTTP endpoint for AI agents (Cursor, Claude Desktop).
 * 
 * Protocol: JSON-RPC 2.0 over HTTP
 * Authentication: Bearer token in Authorization header
 * 
 * Supported methods:
 * - tools/list - List available tools
 * - tools/call - Execute a tool
 * - initialize - Initialize MCP session
 * - ping - Health check
 * 
 * This is a STATELESS implementation - each request is independent.
 * For Cursor/Claude, use:
 * {
 *   "mcpServers": {
 *     "sofinance": {
 *       "url": "https://sofinancelab.xyz/api/mcp",
 *       "headers": { "Authorization": "Bearer <token>" }
 *     }
 *   }
 * }
 */

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

function createJsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, data },
  };
}

function createJsonRpcSuccess(
  id: string | number | null,
  result: unknown
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

async function handleToolCall(name: string, args: unknown, walletFromToken: string) {
  switch (name) {
    case "get_position_performance": {
      const input = getPositionPerformanceSchema.parse(args ?? {});
      // Enforce wallet match when wallet is provided
      if (input.wallet && input.wallet !== walletFromToken) {
        throw new Error(
          `Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`
        );
      }
      return await getPositionPerformance(input);
    }

    case "get_pool_activity": {
      const input = getPoolActivitySchema.parse(args ?? {});
      return await getPoolActivity(input);
    }

    case "get_position_range_status": {
      const input = getPositionRangeStatusSchema.parse(args ?? {});
      if (input.wallet && input.wallet !== walletFromToken) {
        throw new Error(
          `Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`
        );
      }
      return await getPositionRangeStatus(input);
    }

    case "list_rwa_pairs": {
      const input = listRwaPairsSchema.parse(args ?? {});
      // Note: This tool can be slow on Vercel Hobby (10s timeout).
      // Recommend maxPages ≤ 5 or call with smaller minTvl filter.
      return await listRwaPairs(input);
    }

    case "list_positions": {
      const input = listPositionsSchema.parse(args);
      // Enforce that the wallet matches the token
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await listPositions(input);
    }

    case "quote_add_liquidity": {
      const input = quoteAddLiquiditySchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await quoteAddLiquidity(input);
    }

    case "prepare_transaction": {
      const input = prepareTransactionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      // Note: Can take 5-10s on complex swaps (Jupiter routing + simulation).
      // Vercel Hobby timeout is 10s; most calls complete in time.
      return await prepareTransaction(input);
    }

    case "quote_compound": {
      const input = quoteCompoundSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await quoteCompound(input);
    }

    case "prepare_compound_transaction": {
      const input = quoteCompoundSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await prepareCompoundTransaction(input);
    }

    case "submit_signed_transaction": {
      const input = submitSignedTransactionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await submitSignedTransaction(input);
    }

    case "submit_compound_transaction": {
      const input = submitCompoundTransactionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await submitCompoundTransaction(input);
    }

    case "quote_open_position": {
      const input = quoteOpenPositionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await quoteOpenPosition(input);
    }

    case "prepare_open_position": {
      const input = prepareOpenPositionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await prepareOpenPosition(input);
    }

    case "submit_open_position": {
      const input = submitOpenPositionSchema.parse(args);
      if (input.wallet !== walletFromToken) {
        throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      }
      return await submitOpenPosition(input);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

const TOOL_DEFINITIONS = [
  {
    name: "get_position_performance",
    description:
      "Compute holding-period return and realized fee APR for a Raydium CLMM position NFT from on-chain facts (no database, not Raydium pool 24h feeApr). Prefer token-native metrics: for same-asset RWA wrap pairs (e.g. SPCXx/SPCX) report TE in the plain/base ticker using current tick mid (1.0001^tick×10^(decA−decB)), plus raw A/B inventory, holdingDays, feeOnlyAprPct and annualizedReturnPct (HPR×365/days; feesEarned/deposited×365/days). USD is optional/secondary (Jupiter Price v3 / Raydium stable-leg, labeled current — not historical). Discovers open/increase/decrease txs via personal-position signatures + Anchor events + current equity. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        positionMint: {
          type: "string",
          description: "Position NFT mint address (from list_positions)",
        },
        wallet: {
          type: "string",
          description: "Optional wallet to verify NFT ownership (does not change math)",
        },
        maxSignatures: {
          type: "number",
          description: "Max personal-position signatures to scan (1-500, default 100)",
          default: 100,
        },
        skipPricing: {
          type: "boolean",
          description: "If true, skip Jupiter/Raydium USD pricing (token-native / TE metrics still computed)",
          default: false,
        },
      },
      required: ["positionMint"],
    },
  },
  {
    name: "get_pool_activity",
    description:
      "Live Solami Blur snapshot for a Solana pool: decoded pool stats (price, TVL, 24h fees, LP flows) plus recent swaps. Read-only. Returns available=false when SOLAMI_DATA_API_KEY is unset so agents can fall back. Free Solami keys have REST but not WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        poolId: {
          type: "string",
          description: "Pool address (Raydium CLMM id)",
        },
        limit: {
          type: "number",
          description: "Max recent swaps to return (1-200, default 20)",
          default: 20,
        },
      },
      required: ["poolId"],
    },
  },
  {
    name: "get_position_range_status",
    description:
      "Compute live in-range / out-of-range status for a Raydium CLMM position from the latest Solami Blur pool price versus tickLower/tickUpper (B per 1 A). Flags when price approaches a range edge. Falls back to the on-chain mid if Blur is unavailable. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        positionMint: {
          type: "string",
          description: "Position NFT mint address",
        },
        wallet: {
          type: "string",
          description: "Optional wallet; when set it must match the Bearer token",
        },
        poolId: {
          type: "string",
          description: "Optional pool override (defaults to the position's pool)",
        },
      },
      required: ["positionMint"],
    },
  },
  {
    name: "list_rwa_pairs",
    description:
      "Discover Raydium CLMM pools where BOTH sides are the same underlying RWA asset (wrapped vs unwrapped / xStock style), e.g. SPCXx/SPCX, MSTRx/MSTR, NVDAx/NVDA. Excludes RWA/USDC and unrelated meme collisions. Returns pool address, mint symbols, fee tier, TVL, 24h volume/fees, Raydium fee APR, estimated fee APR from (24h fees/TVL)*365*100 (labeled), Token-2022 and freeze-risk flags, openPositionUrl deep link (/app/rwa-pairs?pool=<id>&open=1), and recommendedRanges (tight ±0.05%, standard ±0.3% default, wide ±1%, B per 1 A). Chain: list_rwa_pairs → quote_open_position → prepare_open_position → sign via signUrl → list_positions. Read-only; no wallet required. Pairing rule: FOOx/FOO (or FOO-x / xFOO) symbol wrap + both mints Jupiter-tagged (stocks|rwa; prefer xstocks/backpack) or on the Backed xStocks Solana whitelist.",
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
  {
    name: "quote_open_position",
    description:
      "Quote opening a NEW Raydium CLMM position in a pool (no existing NFT). Input SOL/USDC/pool token, amount, and a price range (presets tight ±0.05% / standard ±0.3% / wide ±1%, or custom minPrice/maxPrice in B per 1 A). Returns expected A/B after Jupiter swap-to-ratio, tick-aligned range, in/out-of-range, price impact, refundable vs non-refundable SOL rent (NFT + tick arrays), and Token-2022/freeze flags. Fails clearly on insufficient balance, >5% impact, transfer-fee/freeze, or unfunded tick arrays the wallet cannot pay. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Wallet public key" },
        poolId: { type: "string", description: "Raydium CLMM pool id (from list_rwa_pairs)" },
        inputMint: { type: "string", description: "SOL, USDC, or a mint in the pool" },
        inputKind: { type: "string", enum: ["native", "token"], description: "'native' for SOL, 'token' otherwise" },
        amount: { type: "string", description: "Amount in token units (e.g. '1.5')" },
        rangePreset: {
          type: "string",
          enum: ["tight", "standard", "wide", "custom"],
          description: "Default standard (±0.3% around current B-per-A price)",
          default: "standard",
        },
        minPrice: { type: "string", description: "Custom range min price (B per 1 A), required if rangePreset=custom" },
        maxPrice: { type: "string", description: "Custom range max price (B per 1 A), required if rangePreset=custom" },
        resaleFloorBps: {
          type: "number",
          description: "Minimum resale ratio in basis points (9500-10000, default 9900)",
          default: 9900,
        },
        slippageToleranceBps: {
          type: "number",
          description: "Open-position price tolerance in basis points (0-500, default 100). Jupiter swap slippage stays 0.5%.",
          default: 100,
        },
      },
      required: ["wallet", "poolId", "inputMint", "inputKind", "amount"],
    },
  },
  {
    name: "prepare_open_position",
    description:
      "Prepare an unsigned, fully-simulated transaction that opens a new CLMM position. Returns base64 tx (already partial-signed by the ephemeral NFT mint; wallet signs as fee payer), HMAC permit, summary, and signUrl. Server never holds keys after prepare; the mint secret is discarded. 1232-byte limit, fresh blockhash, full simulation. After signing, call submit_open_position (not submit_signed_transaction — this tx has two required signers).",
    inputSchema: {
      type: "object",
      properties: {
        wallet: { type: "string", description: "Wallet public key" },
        poolId: { type: "string", description: "Raydium CLMM pool id" },
        inputMint: { type: "string", description: "Input asset mint" },
        inputKind: { type: "string", enum: ["native", "token"] },
        amount: { type: "string", description: "Amount in token units" },
        rangePreset: {
          type: "string",
          enum: ["tight", "standard", "wide", "custom"],
          default: "standard",
        },
        minPrice: { type: "string" },
        maxPrice: { type: "string" },
        resaleFloorBps: { type: "number", default: 9900 },
        slippageToleranceBps: { type: "number", default: 100 },
      },
      required: ["wallet", "poolId", "inputMint", "inputKind", "amount"],
    },
  },
  {
    name: "submit_open_position",
    description:
      "Submit a signed open-position transaction. Re-verifies HMAC permit, re-reads pool/balances, re-simulates (sigVerify true, including the NFT-mint partial signature), then broadcasts. Pass signedTransaction plus permit, wallet, and the complete summary from prepare_open_position, unchanged. Returns signature and the new positionMint.",
    inputSchema: {
      type: "object",
      properties: {
        signedTransaction: { type: "string", description: "Base64-encoded signed transaction" },
        permit: { type: "string", description: "HMAC permit from prepare_open_position" },
        wallet: { type: "string", description: "Wallet public key" },
        summary: {
          type: "object",
          description: "Complete summary object from prepare_open_position, unchanged (bound by the permit)",
        },
      },
      required: ["signedTransaction", "permit", "wallet", "summary"],
    },
  },
];

export async function POST(request: NextRequest) {
  try {
    // Parse JSON-RPC request
    let rpcRequest: JsonRpcRequest;
    try {
      rpcRequest = await request.json();
    } catch {
      return NextResponse.json(
        createJsonRpcError(null, -32700, "Parse error: Invalid JSON"),
        { status: 400 }
      );
    }

    if (rpcRequest.jsonrpc !== "2.0") {
      return NextResponse.json(
        createJsonRpcError(rpcRequest.id ?? null, -32600, "Invalid JSON-RPC version"),
        { status: 400 }
      );
    }

    const { id, method, params } = rpcRequest;

    // Handle public methods (no auth required)
    if (method === "initialize") {
      return NextResponse.json(
        createJsonRpcSuccess(id ?? null, {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "sofinance-mcp-server",
            version: "0.1.0",
          },
          instructions: "Remote MCP server for SoFinance. Authenticate with Bearer token from /api/mcp-token.",
        })
      );
    }

    if (method === "ping") {
      return NextResponse.json(createJsonRpcSuccess(id ?? null, {}));
    }

    if (method === "tools/list") {
      return NextResponse.json(
        createJsonRpcSuccess(id ?? null, {
          tools: TOOL_DEFINITIONS,
        })
      );
    }

    // Authenticate for protected methods
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        createJsonRpcError(id ?? null, -32001, "Unauthorized: Bearer token required"),
        { status: 401 }
      );
    }

    const token = authHeader.slice(7);
    const secret = process.env.JUPITER_API_KEY;
    if (!secret) {
      return NextResponse.json(
        createJsonRpcError(id ?? null, -32002, "Server configuration error"),
        { status: 500 }
      );
    }

    const wallet = verifyMcpToken(token, secret)?.wallet;
    if (!wallet) {
      return NextResponse.json(
        createJsonRpcError(id ?? null, -32001, "Unauthorized: Invalid or expired token"),
        { status: 401 }
      );
    }

    // Handle tool calls
    if (method === "tools/call") {
      if (!params || typeof params !== "object" || !("name" in params)) {
        return NextResponse.json(
          createJsonRpcError(id ?? null, -32602, "Invalid params: tool name required"),
          { status: 400 }
        );
      }

      const toolParams = params as { name: unknown; arguments?: unknown };
      if (typeof toolParams.name !== "string") {
        return NextResponse.json(
          createJsonRpcError(id ?? null, -32602, "Invalid params: tool name must be a string"),
          { status: 400 }
        );
      }

      try {
        const result = await handleToolCall(toolParams.name, toolParams.arguments, wallet);
        return NextResponse.json(
          createJsonRpcSuccess(id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return NextResponse.json(
          createJsonRpcSuccess(id ?? null, {
            content: [
              {
                type: "text",
                text: JSON.stringify({ error: message }, null, 2),
              },
            ],
            isError: true,
          })
        );
      }
    }

    return NextResponse.json(
      createJsonRpcError(id ?? null, -32601, `Method not found: ${method}`),
      { status: 404 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      createJsonRpcError(null, -32603, `Internal error: ${message}`),
      { status: 500 }
    );
  }
}

// Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
