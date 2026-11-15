import "@/lib/engine-host";
import { listToolDefinitions } from "@/mcp/tool-definitions";
import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp-auth";
import { publicToolError } from "@/mcp/public-tool-error";
import { sanitizePublicError } from "@/lib/public-error";
import { captureApiRouteError } from "@/lib/sentry/capture";
import { dispatchTool, isPublicTool, type McpDispatchContext } from "@/mcp/dispatch";
import { getJupiterApiKey } from "@sofinance/engine/config/server-env";
import { PUBLIC_TOOL_NAMES } from "@/mcp/tool-definitions";
import {
  SERVER_INFO, authSteps, isSupportedProtocolVersion, mcpSetupUrl, negotiateProtocolVersion, serverInstructions,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@/mcp/protocol";

/**
 * POST /api/mcp
 * 
 * Remote MCP-over-HTTP endpoint for AI agents (Cursor, Claude Desktop).
 * 
 * Protocol: JSON-RPC 2.0 over HTTP (Streamable HTTP, JSON responses only; versions in SUPPORTED_PROTOCOL_VERSIONS)
 * Authentication: none for the public read-only snapshot tools (PUBLIC_TOOL_NAMES); every other tools/call needs the
 * wallet-bound Bearer token from /app/ai.
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

const WWW_AUTHENTICATE_REALM = 'Bearer realm="sofinance-mcp"';

/**
 * 401 for a token tool: RFC 6750 `WWW-Authenticate` (with `error="invalid_token"` only when a token was sent), and
 * plain next steps in the message and `data` so an agent can tell its user exactly how to get a token.
 */
function unauthorized(id: string | number | null, reason: "missing" | "invalid") {
  const message = reason === "missing"
    ? "Unauthorized: Bearer token required"
    : "Unauthorized: Invalid or expired token";
  const guidance = `This tool is bound to one wallet. To get a token, open ${mcpSetupUrl()}, connect the wallet, click "Sign to get MCP config" and add the Authorization header it shows (valid 24h). ${PUBLIC_TOOL_NAMES.join(" and ")} work without a token.`;
  const challenge = reason === "invalid"
    ? `${WWW_AUTHENTICATE_REALM}, error="invalid_token", error_description="The token is invalid or expired"`
    : WWW_AUTHENTICATE_REALM;
  return NextResponse.json(
    createJsonRpcError(id, -32001, `${message}. ${guidance}`, {
      setupUrl: mcpSetupUrl(),
      steps: authSteps(),
      publicTools: [...PUBLIC_TOOL_NAMES],
    }),
    { status: 401, headers: { "WWW-Authenticate": challenge } },
  );
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

    // Streamable HTTP: after initialize the client sends the negotiated version; reject one this server does not speak.
    const headerVersion = request.headers.get("mcp-protocol-version");
    if (method !== "initialize" && headerVersion !== null && !isSupportedProtocolVersion(headerVersion)) {
      return NextResponse.json(
        createJsonRpcError(id ?? null, -32600, `Unsupported MCP-Protocol-Version: ${headerVersion.slice(0, 32)}`, {
          supported: [...SUPPORTED_PROTOCOL_VERSIONS],
        }),
        { status: 400 },
      );
    }

    // The stateless server has no session to update. Accept the lifecycle
    // notification without a JSON-RPC response, as Streamable HTTP requires.
    if (method === "notifications/initialized" && id === undefined) {
      return new NextResponse(null, { status: 202 });
    }

    // Handle public methods (no auth required)
    if (method === "initialize") {
      return NextResponse.json(
        createJsonRpcSuccess(id ?? null, {
          protocolVersion: negotiateProtocolVersion(
            params && typeof params === "object" ? (params as { protocolVersion?: unknown }).protocolVersion : undefined,
          ),
          capabilities: {
            tools: {},
          },
          serverInfo: { ...SERVER_INFO },
          instructions: serverInstructions(),
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

    // Public read-only snapshot tools run without a token (any Authorization header is ignored for them).
    const toolName = method === "tools/call" && params && typeof params === "object" && "name" in params
      ? (params as { name: unknown }).name : undefined;
    const publicCall = typeof toolName === "string" && isPublicTool(toolName);

    let context: McpDispatchContext = { surface: "mcp-http-public" };
    if (!publicCall) {
      // Authenticate for protected methods
      const authHeader = request.headers.get("Authorization");
      if (!authHeader || !authHeader.startsWith("Bearer ")) return unauthorized(id ?? null, "missing");

      const token = authHeader.slice(7);
      const secret = getJupiterApiKey();
      if (!secret) {
        return NextResponse.json(
          createJsonRpcError(id ?? null, -32002, "Server configuration error"),
          { status: 500 }
        );
      }

      const wallet = verifyMcpToken(token, secret)?.wallet;
      if (!wallet) return unauthorized(id ?? null, "invalid");
      context = { surface: "mcp-http", tokenWallet: wallet };
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
        const result = await dispatchTool(toolParams.name, toolParams.arguments, context);
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

/** Streamable HTTP: this server opens no SSE stream, so GET is 405 (the spec's answer), not a page or 403. */
export function GET() {
  return NextResponse.json(
    createJsonRpcError(null, -32000, "Method not allowed: send JSON-RPC requests with POST"),
    { status: 405, headers: { Allow: "POST, OPTIONS" } },
  );
}

// Handle OPTIONS for CORS preflight
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
    },
  });
}
