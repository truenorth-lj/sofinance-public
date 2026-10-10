#!/usr/bin/env node
/**
 * SoFinance MCP Remote Shim
 * 
 * Zero-secret local proxy that forwards stdio MCP ↔ remote HTTP MCP.
 * 
 * This shim allows Cursor/Claude to use remote MCP when they only support stdio transport.
 * It requires ONLY:
 * - SOFINANCE_MCP_URL (e.g., https://sofinancelab.xyz/api/mcp)
 * - SOFINANCE_MCP_TOKEN (Bearer token from web UI)
 * 
 * NO local SOLANA_RPC_URL or JUPITER_API_KEY needed.
 * 
 * Usage:
 * npx tsx src/mcp/remote-shim.ts
 * 
 * Cursor config:
 * {
 *   "mcpServers": {
 *     "sofinance": {
 *       "command": "npx",
 *       "args": ["tsx", "src/mcp/remote-shim.ts"],
 *       "cwd": "/path/to/sofinance-public",
 *       "env": {
 *         "SOFINANCE_MCP_URL": "https://sofinancelab.xyz/api/mcp",
 *         "SOFINANCE_MCP_TOKEN": "your-token-from-web-ui"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MCP_URL = process.env.SOFINANCE_MCP_URL;
const MCP_TOKEN = process.env.SOFINANCE_MCP_TOKEN;

if (!MCP_URL || !MCP_TOKEN) {
  // eslint-disable-next-line no-console
  console.error(
    "Error: SOFINANCE_MCP_URL and SOFINANCE_MCP_TOKEN environment variables are required"
  );
  // eslint-disable-next-line no-console
  console.error(
    "Get your token from: https://sofinancelab.xyz/app (connect wallet → MCP Connection)"
  );
  process.exit(1);
}

/**
 * Forward a JSON-RPC request to the remote MCP server
 */
async function forwardRequest(method: string, params?: unknown): Promise<unknown> {
  if (!MCP_URL) {
    throw new Error("SOFINANCE_MCP_URL is not set");
  }

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${MCP_TOKEN}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method,
      params,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Remote MCP error: ${response.status} ${errorText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`Remote MCP error: ${data.error.message}`);
  }

  return data.result;
}

/**
 * Create local stdio MCP server that forwards to remote HTTP
 */
const server = new Server(
  {
    name: "sofinance-mcp-remote-shim",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Forward tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const result = await forwardRequest("tools/list");
  return result as { tools: unknown[] };
});

// Forward tools/call
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const result = await forwardRequest("tools/call", request.params);
    return result as { content: { type: string; text: string }[] };
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

// Start stdio transport
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr (stdout is reserved for MCP protocol)
  // eslint-disable-next-line no-console
  console.error("SoFinance MCP remote shim running");
  // eslint-disable-next-line no-console
  console.error(`Forwarding to: ${MCP_URL}`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", error);
  process.exit(1);
});
