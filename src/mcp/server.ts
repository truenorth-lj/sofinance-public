#!/usr/bin/env node
// Must stay the first import: lets the Next.js "server-only" guard load in a
// plain Node process, so `npx tsx src/mcp/server.ts` works without NODE_OPTIONS.
import "./server-only-mock.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./create-server.js";

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await createMcpServer().connect(transport);
  
  // Log to stderr (stdout is reserved for MCP protocol)
  // eslint-disable-next-line no-console
  console.error("SoFinance MCP server running on stdio");
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error:", error);
  process.exit(1);
});
