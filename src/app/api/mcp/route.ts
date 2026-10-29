import "@/lib/engine-host";
import { listEnabledToolDefinitions } from "@/mcp/tool-availability";
import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp-auth";
import { publicToolError } from "@/mcp/public-tool-error";
import { sanitizePublicError } from "@/lib/public-error";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { dispatchTool } from "@/mcp/dispatch";
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
          tools: listEnabledToolDefinitions("http"),
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
        const result = await dispatchTool(toolParams.name, toolParams.arguments, { surface: "mcp-http", tokenWallet: wallet });
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
