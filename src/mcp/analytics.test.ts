import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { classifyToolError, MCP_ANONYMOUS_DISTINCT_ID, MCP_TOOL_CALLED, mcpToolCallEvents, type McpToolCallRecord } from "./analytics";
import { walletDistinctId } from "../lib/analytics/server-capture";

const wallet = "So11111111111111111111111111111111111111112";
const pool = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
const mint = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
const signature = "5".repeat(88);
const base: McpToolCallRecord = {
  calledName: "list_rwa_pairs", outcome: "success", auth: "none", protocol: "2025-06-18", httpStatus: 200, durationMs: 41.6,
  host: "sofinancelab.xyz",
};

describe("mcp_tool_called", () => {
  it("public call with no wallet: anonymous id, annotations, alias_used false, no error code", () => {
    expect(mcpToolCallEvents(base)).toEqual([{
      event: MCP_TOOL_CALLED, distinctId: MCP_ANONYMOUS_DISTINCT_ID,
      properties: {
        tool: "list_rwa_pairs", alias_used: false, outcome: "success", auth: "none", read_only: true, destructive: false,
        protocol: "2025-06-18", duration_ms: 42, http_status: 200, wallet_known: false, source: "mcp", $host: "sofinancelab.xyz",
      },
    }]);
  });

  it("wallet comes from the token, else the wallet argument, and only as a sha256 distinct id", () => {
    const [fromArg] = mcpToolCallEvents({ ...base, calledName: "list_positions", args: { wallet } });
    expect(fromArg!.distinctId).toBe(walletDistinctId(wallet));
    expect(fromArg!.properties.wallet_known).toBe(true);
    const tokenWallet = "Vote111111111111111111111111111111111111111";
    const [fromToken] = mcpToolCallEvents({ ...base, calledName: "quote_compound", auth: "bearer", tokenWallet, args: { wallet, positionMint: mint } });
    expect(fromToken!.distinctId).toBe(walletDistinctId(tokenWallet));
    expect(fromToken!.properties).toMatchObject({ auth: "bearer", position_mint: mint, read_only: true });
  });

  it("never carries arguments, raw wallet, permits, transactions or sign links", () => {
    const args = { wallet, signedTransaction: "AQID".repeat(40), permit: "permit-secret", summary: { poolId: pool, nftMint: mint, signUrl: "https://x/app/sign/abc" } };
    const events = mcpToolCallEvents({ ...base, calledName: "submit_open_position", auth: "bearer", tokenWallet: wallet, args,
      outcome: "rejected", errorCode: "permit_invalid" });
    const text = JSON.stringify(events);
    for (const secret of [wallet, "AQIDAQID", "permit-secret", "/app/sign/"]) expect(text).not.toContain(secret);
    expect(events).toHaveLength(1);
    expect(events[0]!.properties).toMatchObject({ tool: "submit_open_position", destructive: true, read_only: false,
      pool_id: pool, position_mint: mint, outcome: "rejected", error_code: "permit_invalid" });
  });

  it("unknown or non-string tool names are 'unknown'; junk ids and hosts are dropped", () => {
    const [event] = mcpToolCallEvents({ ...base, calledName: "drop table", args: { wallet: "not a wallet", poolId: "x".repeat(50) }, host: "evil host/<x>" });
    expect(event!.properties).toMatchObject({ tool: "unknown", read_only: false, destructive: false, wallet_known: false });
    expect(event!.properties).not.toHaveProperty("pool_id");
    expect(event!.properties).not.toHaveProperty("$host");
    expect(mcpToolCallEvents({ ...base, calledName: 42 })[0]!.properties.tool).toBe("unknown");
  });
});

describe("MCP open tagging", () => {
  const open: McpToolCallRecord = { ...base, calledName: "submit_open_position", auth: "bearer", tokenWallet: wallet,
    args: { wallet, summary: { poolId: pool, nftMint: mint } }, result: { signature, positionMint: mint } };

  it("a successful submit_open_position also sends open_position_success with source mcp (north-star counts it)", () => {
    const events = mcpToolCallEvents(open);
    expect(events.map((item) => item.event)).toEqual([MCP_TOOL_CALLED, "open_position_success"]);
    expect(events[1]).toEqual({ event: "open_position_success", distinctId: walletDistinctId(wallet),
      properties: { source: "mcp", position_mint: mint, signature, pool, $host: "sofinancelab.xyz" } });
  });

  it("no open event for errors, other write tools, or a result without signature", () => {
    expect(mcpToolCallEvents({ ...open, outcome: "error", errorCode: "tool_failed" })).toHaveLength(1);
    expect(mcpToolCallEvents({ ...open, calledName: "submit_withdraw" })).toHaveLength(1);
    expect(mcpToolCallEvents({ ...open, result: { positionMint: mint } })).toHaveLength(1);
  });
});

describe("classifyToolError", () => {
  it.each([
    ["Invalid arguments: wallet: required", "rejected", "invalid_arguments"],
    ["Unknown tool: nope", "rejected", "unknown_tool"],
    ["Token wallet mismatch: token is for A, requested B", "rejected", "wallet_mismatch"],
    ["Price impact 7% exceeds 5%; pass confirmHighImpact=true", "rejected", "high_impact_unconfirmed"],
    ["Open-position authorization type, wallet, or expiry mismatch", "rejected", "permit_invalid"],
    ["Wallet signature is invalid", "rejected", "signature_invalid"],
    ["Signed transaction expired before broadcast", "rejected", "expired"],
    ["RPC unavailable", "error", "tool_failed"],
  ])("%s -> %s/%s", (message, outcome, errorCode) => {
    expect(classifyToolError(message)).toEqual({ outcome, errorCode });
  });
});
