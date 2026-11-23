// Per-IP rate limits on POST /api/mcp: real route, dispatch and limiter; tool handlers mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", () => ({ captureApiRouteError: vi.fn() }));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance", "getPositionRangeStatus",
  "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition", "prepareWithdraw", "submitWithdrawTransaction",
  "getPoolRangeApr", "txStatus",
].map((name) => [name, vi.fn(async () => ({ ok: true }))])));
import { NextRequest } from "next/server";
import { captureApiRouteError } from "@/lib/sentry/capture";
import * as tools from "@/mcp/tools";
import { testKeypair } from "@/lib/test-support/send-fixtures";
import {
  MCP_POSITION_READS_PER_IP_PER_MINUTE, MCP_REQUESTS_PER_IP_PER_MINUTE, MCP_TOOL_CALLS_PER_IP_PER_MINUTE, resetMcpRateLimit,
} from "@/lib/mcp-rate-limit";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const signature = "1".repeat(64);
async function send(body: unknown, ip = "203.0.113.7") {
  const response = await POST(new NextRequest("http://localhost/api/mcp", {
    method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body),
  }));
  return { response, json: await response.json() };
}
const tool = (name: string, args: unknown, ip?: string) =>
  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, ip);
const list = (ip?: string) => send({ jsonrpc: "2.0", id: 1, method: "tools/list" }, ip);

beforeEach(() => { resetMcpRateLimit(); vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });


describe("POST /api/mcp per-IP rate limits", () => {
  it("chosen limits: position reads 12, tool calls 60, all requests 120 per minute", () => {
    expect([MCP_POSITION_READS_PER_IP_PER_MINUTE, MCP_TOOL_CALLS_PER_IP_PER_MINUTE, MCP_REQUESTS_PER_IP_PER_MINUTE]).toEqual([12, 60, 120]);
  });

  it("position reads share a 12/min budget; the 13th is 429 / -32029 with Retry-After, no handler and no Sentry", async () => {
    const reads = [["positions_list", { wallet }], ["position_get_range_status", { positionMint: wallet }],
      ["position_get_performance", { positionMint: wallet }]] as const;
    for (let i = 0; i < MCP_POSITION_READS_PER_IP_PER_MINUTE; i++) {
      const [name, args] = reads[i % reads.length]!;
      expect((await tool(name, args)).response.status).toBe(200);
    }
    const { response, json } = await tool("positions_list", { wallet });
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(json).toMatchObject({ jsonrpc: "2.0", id: 3, error: { code: -32029,
      data: { scope: "position-reads", limitPerMinute: 12, retryAfterSeconds: 60 } } });
    expect(json.error.message).toBe("Rate limited: more than 12 position reads per minute from this IP. Retry after 60 seconds.");
    expect(vi.mocked(tools.listPositions)).toHaveBeenCalledTimes(4);
    expect(captureApiRouteError).not.toHaveBeenCalled();
  });

  it("cheap tools such as tx_status are not held back by the position-read budget", async () => {
    for (let i = 0; i < MCP_POSITION_READS_PER_IP_PER_MINUTE; i++) await tool("positions_list", { wallet });
    expect((await tool("positions_list", { wallet })).response.status).toBe(429);
    expect((await tool("tx_status", { signature })).response.status).toBe(200);
    expect((await tool("pools_list", {})).response.status).toBe(200);
  });

  it("tool calls share a 60/min budget (tx_status polled every 2 s fits)", async () => {
    for (let i = 0; i < MCP_TOOL_CALLS_PER_IP_PER_MINUTE; i++) expect((await tool("tx_status", { signature })).response.status).toBe(200);
    const { response, json } = await tool("tx_status", { signature });
    expect(response.status).toBe(429);
    expect(json.error.data).toMatchObject({ scope: "tool-calls", limitPerMinute: 60 });
    expect(vi.mocked(tools.txStatus)).toHaveBeenCalledTimes(60);
    expect((await list()).response.status).toBe(200);
  });

  it("every request counts toward 120/min, including discovery", async () => {
    for (let i = 0; i < MCP_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await list()).response.status).toBe(200);
    const { response, json } = await list();
    expect(response.status).toBe(429);
    expect(json).toMatchObject({ id: 1, error: { code: -32029, data: { scope: "requests", limitPerMinute: 120 } } });
    expect((await tool("tx_status", { signature })).response.status).toBe(429);
  });

  it("limits are per IP", async () => {
    for (let i = 0; i < MCP_POSITION_READS_PER_IP_PER_MINUTE; i++) await tool("positions_list", { wallet }, "198.51.100.1");
    expect((await tool("positions_list", { wallet }, "198.51.100.1")).response.status).toBe(429);
    expect((await tool("positions_list", { wallet }, "198.51.100.2")).response.status).toBe(200);
  });

  it("the budget refills after a minute", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let i = 0; i < MCP_POSITION_READS_PER_IP_PER_MINUTE; i++) await tool("positions_list", { wallet });
      expect((await tool("positions_list", { wallet })).response.status).toBe(429);
      vi.setSystemTime(Date.now() + 60_001);
      expect((await tool("positions_list", { wallet })).response.status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it("a limited token tool answers 429 before auth (no token check, no 401)", async () => {
    for (let i = 0; i < MCP_TOOL_CALLS_PER_IP_PER_MINUTE; i++) await tool("tx_status", { signature });
    const { response } = await tool("lp_compound_quote", { wallet, positionMint: wallet });
    expect(response.status).toBe(429);
  });
});
