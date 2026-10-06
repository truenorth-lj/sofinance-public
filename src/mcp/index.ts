/**
 * SoFinance MCP Server Entry Point
 * 
 * Run with: pnpm mcp:start
 * Or via npx: npx tsx src/mcp/server.ts
 * 
 * This server exposes SoFinance's Raydium CLMM position management
 * capabilities to AI agents via the Model Context Protocol (MCP).
 */

export * from "./tools.js";
export * from "./schemas.js";
