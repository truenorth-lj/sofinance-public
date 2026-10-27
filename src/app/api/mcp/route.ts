import "@/lib/engine-host";
import { listToolDefinitions } from "@/mcp/tool-definitions";
import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp-auth";
import { publicToolError } from "@/mcp/public-tool-error";
import { sanitizePublicError } from "@/lib/public-error";
import { captureApiRouteError } from "@/lib/sentry/capture";
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
  prepareWithdraw,
  submitWithdrawTransaction,
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
  prepareWithdrawSchema,
  submitWithdrawSchema,
  submitOpenPositionSchema,
} from "@/mcp/schemas";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";

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
 * - notifications/initialized - Acknowledge completed initialization
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

    case "prepare_withdraw": {
      const input = prepareWithdrawSchema.parse(args);
      if (input.wallet !== walletFromToken) throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      return prepareWithdraw(input);
    }
    case "submit_withdraw": {
      const input = submitWithdrawSchema.parse(args) as Parameters<typeof submitWithdrawTransaction>[0];
      if (input.wallet !== walletFromToken) throw new Error(`Token wallet mismatch: token is for ${walletFromToken}, requested ${input.wallet}`);
      return submitWithdrawTransaction(input);
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

    // The stateless server has no session to update. Accept the lifecycle
    // notification without a JSON-RPC response, as Streamable HTTP requires.
    if (method === "notifications/initialized" && id === undefined) {
      return new NextResponse(null, { status: 202 });
    }

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
          tools: listToolDefinitions("http"),
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
    const secret = getJupiterApiKey();
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
        captureApiRouteError(error, { request, route: "/api/mcp", fallback: "MCP tool call failed", status: 400 });
        const message = publicToolError(error);
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
    captureApiRouteError(error, { request, route: "/api/mcp", fallback: "unexpected failure", status: 500 });
    const message = sanitizePublicError(error, "unexpected failure");
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
