// Characterization test for the local stdio MCP server (src/mcp/server.ts): it is started as a real
// child process and spoken to over stdio JSON-RPC with the official SDK client. No network is used:
// only tools/list and calls that fail before touching any backend are exercised.
// Full snapshots preserve each transport's discovery contract, including its known differences.
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { beforeEach, afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resetMcpRateLimit } from "@/lib/mcp-rate-limit";

vi.mock("server-only", () => ({}));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance",
  "getPositionRangeStatus", "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition", "prepareWithdraw", "submitWithdrawTransaction", "getPoolRangeApr", "txStatus",
].map((name) => [name, vi.fn()])));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";

const EXPECTED_NAMES = [
  "lp_withdraw_prepare", "lp_withdraw_submit",
  "position_get_performance", "position_get_range_status", "pools_list", "pool_get_range_apr", "positions_list",
  "lp_add_quote", "lp_add_prepare", "lp_compound_quote", "lp_compound_prepare",
  "lp_add_submit", "lp_compound_submit", "lp_open_quote", "lp_open_prepare", "lp_open_submit", "tx_status",
];
const root = path.resolve(__dirname, "../..");
let client: Client;

beforeAll(async () => {
  // Clean env: nothing from the developer's shell (keys, RPC URLs) may reach the child.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const transport = new StdioClientTransport({
    command: path.join(root, "node_modules/.bin/tsx"), args: [path.join(root, "src/mcp/server.ts")], cwd: root, env, stderr: "ignore",
  });
  client = new Client({ name: "characterization-test", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => { await client?.close(); });

describe("stdio MCP server", () => {
  it("preserves the complete stdio discovery response", async () => {
    expect((await client.listTools()).tools).toMatchSnapshot();
  });

  it("preserves the complete public HTTP discovery response", async () => {
    const response = await POST(new NextRequest("http://localhost/api/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchSnapshot();
  });

  it("identifies itself", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "sofinance-mcp-server", version: "0.3.0" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  function flatten(value: unknown, prefix = ""): Record<string, unknown> {
    if (value === null || typeof value !== "object") return { [prefix]: value };
    return Object.assign({}, ...Object.entries(value).map(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)));
  }

  it("lists the same 17 tool names as the HTTP route", async () => {
    const stdio = await client.listTools();
    expect(stdio.tools).toHaveLength(17);
    expect(stdio.tools.map((tool) => tool.name).sort()).toEqual([...EXPECTED_NAMES].sort());
  });

  it("matches the HTTP route's definitions by name, except for the drift pinned here", async () => {
    const stdio = await client.listTools();
    const http = await (await POST(new NextRequest("http://localhost/api/mcp", {
      method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }))).json() as { result: { tools: { name: string }[] } };
    const index = (tools: { name: string }[]) => Object.fromEntries(tools.map((tool) => [tool.name, tool]));
    const a = flatten(index(stdio.tools));
    const b = flatten(index(http.result.tools));
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    const differing = Object.keys(a).filter((key) => a[key] !== b[key]).sort();
    // Preserve the existing surface-specific wording during metadata consolidation.
    expect(differing).toEqual([
      "lp_open_quote.inputSchema.properties.resaleFloorBps.description",
    ]);
  });

  it("QUIRK: the stdio server lists the tools in a different ORDER than the HTTP route (lp_compound_submit is last)", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "lp_withdraw_prepare", "lp_withdraw_submit",
  "position_get_performance", "position_get_range_status", "pools_list", "pool_get_range_apr", "positions_list",
      "lp_add_quote", "lp_add_prepare", "lp_compound_quote", "lp_compound_prepare",
      "lp_add_submit", "lp_open_quote", "lp_open_prepare", "lp_open_submit", "tx_status",
      "lp_compound_submit",
    ]);
  });

  it("get_pool_activity was removed: a call is an unknown tool", async () => {
    const result = await client.callTool({ name: "get_pool_activity", arguments: { poolId: "DUzBLHZ5RZdftPuWVijsvjupndogRM1adGJpsR7YTJro" } });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0]!.text).toContain("Unknown tool: get_pool_activity");
  });

  it("an unknown tool is an isError result with the (sanitized, unchanged) message", async () => {
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: "Unknown tool: nope" });
  });

  it("QUIRK: the stdio server has NO wallet binding; argument validation (zod) is the only gate", async () => {
    const result = await client.callTool({ name: "positions_list", arguments: { wallet: "not-a-wallet" } });
    expect(result.isError).toBe(true);
    // STEP 2a: the stdio catch uses the same sanitizer as the HTTP route (flattened zod error).
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: "Invalid arguments: wallet: Invalid Solana public key" });
  }, 30_000);
});

// /api/mcp keeps per-IP rate-limit counts in module memory; every test starts with fresh budgets.
beforeEach(() => resetMcpRateLimit());
