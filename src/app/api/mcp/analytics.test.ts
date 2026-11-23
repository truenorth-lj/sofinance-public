// POST /api/mcp analytics wiring: real route and dispatch; tool handlers and the PostHog sender mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@/lib/sentry/capture", () => ({ captureApiRouteError: vi.fn() }));
vi.mock("@/lib/analytics/server-capture", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/analytics/server-capture")>()),
  sendServerEvents: vi.fn(async () => {}),
}));
vi.mock("@/mcp/open-confirmation", () => ({ captureMcpOpenWhenConfirmed: vi.fn(async () => "confirmed") }));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance", "getPositionRangeStatus",
  "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition", "prepareWithdraw", "submitWithdrawTransaction",
  "getPoolRangeApr", "txStatus",
].map((name) => [name, vi.fn(async () => ({ ok: true }))])));
import { NextRequest } from "next/server";
import * as tools from "@/mcp/tools";
import { captureMcpOpenWhenConfirmed } from "@/mcp/open-confirmation";
import { sendServerEvents, walletDistinctId, type ServerEvent } from "@/lib/analytics/server-capture";
import { generateMcpToken } from "@/lib/mcp-auth";
import { SIGNING_SECRET, testKeypair } from "@/lib/test-support/send-fixtures";
import { MCP_TOOL_CALLS_PER_IP_PER_MINUTE, resetMcpRateLimit } from "@/lib/mcp-rate-limit";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const mint = testKeypair(2).publicKey.toBase58();
const pool = testKeypair(3).publicKey.toBase58();
async function send(body: unknown, headers: Record<string, string> = {}) {
  const response = await POST(new NextRequest("http://sofinancelab.xyz/api/mcp", {
    method: "POST", body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": "203.0.113.9", "mcp-protocol-version": "2025-06-18", ...headers },
  }));
  return { response, json: await response.json() };
}
const call = (name: unknown, args: unknown, headers?: Record<string, string>) =>
  send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, headers);
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const sent = (): ServerEvent[] => vi.mocked(sendServerEvents).mock.calls.flatMap(([events]) => [...events]);

beforeEach(() => {
  resetMcpRateLimit();
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.stubEnv("SOFINANCE_SIGNING_SECRET", undefined);
  vi.stubEnv("SOFINANCE_SIGNING_SECRET_PREVIOUS", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe("POST /api/mcp analytics", () => {
  it("public call: one mcp_tool_called with hashed wallet, auth none, protocol and host", async () => {
    expect((await call("list_positions", { wallet })).response.status).toBe(200);
    expect(sendServerEvents).toHaveBeenCalledTimes(1);
    expect(sent()).toEqual([{ event: "mcp_tool_called", distinctId: walletDistinctId(wallet), properties: expect.objectContaining({
      tool: "list_positions", alias_used: false, outcome: "success", auth: "none", read_only: true, destructive: false,
      protocol: "2025-06-18", http_status: 200, wallet_known: true, source: "mcp", $host: "sofinancelab.xyz",
    }) }]);
  });

  it("a token sent to a public tool is not reported as bearer and never appears in the event", async () => {
    const token = generateMcpToken(wallet, SIGNING_SECRET);
    await call("tx_status", { signature: "1".repeat(64) }, bearer(token));
    expect(sent()[0]!.properties).toMatchObject({ tool: "tx_status", auth: "none" });
    expect(JSON.stringify(sent())).not.toContain(token);
  });

  it("token tools: missing, invalid and valid tokens are rejected/rejected/bearer", async () => {
    await call("quote_compound", { wallet, positionMint: mint });
    await call("quote_compound", { wallet, positionMint: mint }, bearer("garbage"));
    await call("quote_compound", { wallet, positionMint: mint }, bearer(generateMcpToken(wallet, SIGNING_SECRET)));
    expect(sent().map((event) => [event.properties.outcome, event.properties.auth, event.properties.error_code ?? null, event.properties.http_status]))
      .toEqual([["rejected", "none", "auth_missing", 401], ["rejected", "invalid", "auth_invalid", 401], ["success", "bearer", null, 200]]);
  });

  it("tool errors carry a stable code, not the message", async () => {
    await call("list_positions", { wallet: "nope" });
    expect(sent()[0]!.properties).toMatchObject({ outcome: "rejected", error_code: "invalid_arguments", http_status: 200 });
    vi.mocked(tools.txStatus).mockRejectedValueOnce(new Error("RPC unavailable at https://rpc.example/?api-key=abc"));
    await call("tx_status", { signature: "1".repeat(64) });
    expect(sent()[1]!.properties).toMatchObject({ outcome: "error", error_code: "tool_failed" });
    expect(JSON.stringify(sent())).not.toContain("api-key");
  });

  const signature = "4".repeat(88);
  const submitOpen = async () => {
    vi.mocked(tools.submitOpenPosition).mockResolvedValueOnce({ signature, positionMint: mint } as never);
    await call("submit_open_position", { wallet, signedTransaction: "AQID", permit: "p", summary: { poolId: pool, nftMint: mint, lastValidBlockHeight: 99 } },
      bearer(generateMcpToken(wallet, SIGNING_SECRET)));
    await vi.waitFor(() => expect(sendServerEvents).toHaveBeenCalledTimes(1));
  };

  it("MCP open: open_position_submitted in the same batch; no confirmation poll outside production", async () => {
    await submitOpen();
    expect(sent().map((event) => event.event)).toEqual(["mcp_tool_called", "open_position_submitted"]);
    expect(sent()[1]).toEqual({ event: "open_position_submitted", distinctId: walletDistinctId(wallet),
      properties: { source: "mcp", position_mint: mint, signature, pool, $host: "sofinancelab.xyz" } });
    expect(captureMcpOpenWhenConfirmed).not.toHaveBeenCalled();
  });

  it("production: after the batch, the open is handed to the confirmation poll with its success event", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_key");
    await submitOpen();
    await vi.waitFor(() => expect(captureMcpOpenWhenConfirmed).toHaveBeenCalledTimes(1));
    expect(vi.mocked(captureMcpOpenWhenConfirmed).mock.calls[0]![0]).toEqual({ signature, lastValidBlockHeight: 99,
      event: { event: "open_position_success", distinctId: walletDistinctId(wallet),
        properties: { source: "mcp", position_mint: mint, signature, pool, $host: "sofinancelab.xyz" } } });
  });

  it("production: a non-open call never starts a confirmation poll", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_POSTHOG_KEY", "phc_test_key");
    await call("list_positions", { wallet });
    expect(captureMcpOpenWhenConfirmed).not.toHaveBeenCalled();
  });

  it("no event for discovery, initialize, ping, or a rate-limited call", async () => {
    await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    await send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await send({ jsonrpc: "2.0", id: 3, method: "ping" });
    expect(sendServerEvents).not.toHaveBeenCalled();
    for (let i = 0; i < MCP_TOOL_CALLS_PER_IP_PER_MINUTE; i++) await call("tx_status", { signature: "1".repeat(64) });
    expect((await call("tx_status", { signature: "1".repeat(64) })).response.status).toBe(429);
    expect(sendServerEvents).toHaveBeenCalledTimes(MCP_TOOL_CALLS_PER_IP_PER_MINUTE);
  });
});
