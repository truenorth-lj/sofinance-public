// Pre-0.3 tool names (PR-5 rename): hidden from tools/list, still callable, same auth and limits, logged alias_used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", () => ({ captureApiRouteError: vi.fn() }));
vi.mock("@/lib/analytics/server-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/server-capture")>()),
  sendServerEvents: vi.fn(async () => {}),
}));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance", "getPositionRangeStatus",
  "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition", "prepareWithdraw", "submitWithdrawTransaction",
  "getPoolRangeApr", "txStatus",
].map((name) => [name, vi.fn(async () => ({ ok: true }))])));
import { NextRequest } from "next/server";
import * as tools from "@/mcp/tools";
import { sendServerEvents, type ServerEvent } from "@/lib/analytics/server-capture";
import { generateMcpToken } from "@/lib/mcp-auth";
import { SIGNING_SECRET, testKeypair } from "@/lib/test-support/send-fixtures";
import { MCP_POSITION_READS_PER_IP_PER_MINUTE, resetMcpRateLimit } from "@/lib/mcp-rate-limit";
import { TOOL_ALIASES } from "@/mcp/tool-definitions";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const mint = testKeypair(2).publicKey.toBase58();
async function send(body: unknown, headers: Record<string, string> = {}) {
  const response = await POST(new NextRequest("http://sofinancelab.xyz/api/mcp", {
    method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", "x-real-ip": "203.0.113.11", ...headers },
  }));
  return { response, json: await response.json() };
}
const call = (name: string, args: unknown, headers?: Record<string, string>) =>
  send({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, headers);
const events = (): ServerEvent[] => vi.mocked(sendServerEvents).mock.calls.flatMap(([batch]) => [...batch]);

beforeEach(() => {
  resetMcpRateLimit();
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.stubEnv("SOFINANCE_SIGNING_SECRET", undefined);
  vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("hidden pre-0.3 tool aliases", () => {
  it("rename map: 16 old names -> new names; none of the old names is in tools/list", async () => {
    expect(TOOL_ALIASES).toEqual({
      list_rwa_pairs: "pools_list", get_pool_range_apr: "pool_get_range_apr", list_positions: "positions_list",
      get_position_range_status: "position_get_range_status", get_position_performance: "position_get_performance",
      quote_open_position: "lp_open_quote", prepare_open_position: "lp_open_prepare", submit_open_position: "lp_open_submit",
      quote_add_liquidity: "lp_add_quote", prepare_transaction: "lp_add_prepare", submit_signed_transaction: "lp_add_submit",
      quote_compound: "lp_compound_quote", prepare_compound_transaction: "lp_compound_prepare",
      submit_compound_transaction: "lp_compound_submit", prepare_withdraw: "lp_withdraw_prepare", submit_withdraw: "lp_withdraw_submit",
    });
    const { json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const listed = json.result.tools.map((tool: { name: string }) => tool.name);
    expect(listed).toHaveLength(17);
    for (const alias of Object.keys(TOOL_ALIASES)) expect(listed).not.toContain(alias);
  });

  it("an old public name runs the same handler with no token, says which name to use, and logs alias_used", async () => {
    const { response, json } = await call("list_rwa_pairs", {});
    expect(response.status).toBe(200);
    expect(tools.listRwaPairs).toHaveBeenCalledTimes(1);
    expect(json.result.isError).toBeUndefined();
    expect(json.result._meta.deprecated).toBe("list_rwa_pairs was renamed to pools_list; call pools_list instead (the old name still works for now).");
    expect(events()[0]!.properties).toMatchObject({ tool: "pools_list", alias_used: true, outcome: "success", auth: "none" });
  });

  it("a new name has no deprecation note and logs alias_used false", async () => {
    const { json } = await call("pools_list", {});
    expect(json.result._meta).toBeUndefined();
    expect(events()[0]!.properties).toMatchObject({ tool: "pools_list", alias_used: false });
  });

  it("an old token-tool name still needs the token, and works with it", async () => {
    expect((await call("quote_compound", { wallet, positionMint: mint })).response.status).toBe(401);
    const { response, json } = await call("quote_compound", { wallet, positionMint: mint },
      { authorization: `Bearer ${generateMcpToken(wallet, SIGNING_SECRET)}` });
    expect(response.status).toBe(200);
    expect(json.result._meta.deprecated).toMatch(/call lp_compound_quote instead/);
    expect(tools.quoteCompound).toHaveBeenCalledTimes(1);
    expect(events().map((event) => [event.properties.tool, event.properties.alias_used, event.properties.outcome]))
      .toEqual([["lp_compound_quote", true, "rejected"], ["lp_compound_quote", true, "success"]]);
  });

  it("old position-read names share the 12/min position-read budget", async () => {
    for (let i = 0; i < MCP_POSITION_READS_PER_IP_PER_MINUTE; i++) {
      expect((await call(i % 2 ? "list_positions" : "positions_list", { wallet })).response.status).toBe(200);
    }
    expect((await call("list_positions", { wallet })).response.status).toBe(429);
  });
});
