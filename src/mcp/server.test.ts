// Characterization test for the local stdio MCP server (src/mcp/server.ts): it is started as a real
// child process and spoken to over stdio JSON-RPC with the official SDK client. No network is used:
// only tools/list and calls that fail before touching any backend are exercised.
// The stdio list must stay identical to the HTTP route's list (the two are hand-copied today).
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance", "getPoolActivity",
  "getPositionRangeStatus", "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition",
].map((name) => [name, vi.fn()])));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";

const EXPECTED_NAMES = [
  "get_position_performance", "get_pool_activity", "get_position_range_status", "list_rwa_pairs", "list_positions",
  "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction",
  "submit_signed_transaction", "submit_compound_transaction", "quote_open_position", "prepare_open_position", "submit_open_position",
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
  it("identifies itself", () => {
    expect(client.getServerVersion()).toMatchObject({ name: "sofinance-mcp-server", version: "0.1.0" });
    expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
  });

  function flatten(value: unknown, prefix = ""): Record<string, unknown> {
    if (value === null || typeof value !== "object") return { [prefix]: value };
    return Object.assign({}, ...Object.entries(value).map(([key, item]) => flatten(item, prefix ? `${prefix}.${key}` : key)));
  }

  it("lists the same 14 tool names as the HTTP route", async () => {
    const stdio = await client.listTools();
    expect(stdio.tools).toHaveLength(14);
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
    // DRIFT (pinned, not fixed): the two hand-copied definitions disagree on the wording of these fields.
    expect(differing).toEqual([
      "quote_open_position.inputSchema.properties.resaleFloorBps.description",
    ]);
  });

  it("QUIRK: the stdio server lists the tools in a different ORDER than the HTTP route (submit_compound_transaction is last)", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual([
      "get_position_performance", "get_pool_activity", "get_position_range_status", "list_rwa_pairs", "list_positions",
      "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction",
      "submit_signed_transaction", "quote_open_position", "prepare_open_position", "submit_open_position",
      "submit_compound_transaction",
    ]);
  });

  it("an unknown tool is an isError result with the (sanitized, unchanged) message", async () => {
    const result = await client.callTool({ name: "nope", arguments: {} });
    expect(result.isError).toBe(true);
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: "Unknown tool: nope" });
  });

  it("QUIRK: the stdio server has NO wallet binding; argument validation (zod) is the only gate", async () => {
    const result = await client.callTool({ name: "list_positions", arguments: { wallet: "not-a-wallet" } });
    expect(result.isError).toBe(true);
    // STEP 2a: the stdio catch uses the same sanitizer as the HTTP route (flattened zod error).
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ error: "Invalid arguments: wallet: Invalid Solana public key" });
  }, 30_000);
});
