// Characterization tests for the remote MCP endpoint (POST /api/mcp): JSON-RPC envelope, bearer
// auth, the tools/list wire contract (golden snapshot) and per-tool wallet binding.
// Real: route, mcp-auth token verification, zod schemas. Mocked: the 16 tool implementations.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/mcp/tools", () => Object.fromEntries([
  "listPositions", "quoteAddLiquidity", "prepareTransaction", "quoteCompound", "prepareCompoundTransaction",
  "submitSignedTransaction", "submitCompoundTransaction", "listRwaPairs", "getPositionPerformance", "getPoolActivity",
  "getPositionRangeStatus", "quoteOpenPosition", "prepareOpenPosition", "submitOpenPosition", "prepareWithdraw", "submitWithdrawTransaction",
].map((name) => [name, vi.fn()])));

import { NextRequest } from "next/server";
import { generateMcpToken } from "@/lib/mcp-auth";
import * as schemas from "@/mcp/schemas";
import * as tools from "@/mcp/tools";
import { SIGNING_SECRET, testKeypair } from "@/lib/test-support/send-fixtures";
import { OPTIONS, POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const otherWallet = testKeypair(2).publicKey.toBase58();
const mint = testKeypair(3).publicKey.toBase58();
const pool = testKeypair(4).publicKey.toBase58();
const toolFns = tools as unknown as Record<string, ReturnType<typeof vi.fn>>;

function rpc(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/mcp", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
const goodToken = () => generateMcpToken(wallet, SIGNING_SECRET);

async function send(body: unknown, headers: Record<string, string> = {}) {
  const response = await POST(rpc(body, headers));
  return { response, json: await response.json() as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
async function callTool(name: string, args: unknown, token = goodToken()) {
  return send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }, bearer(token));
}

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(toolFns)) fn.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

// -------------------------------------------------------------------- tools/list contract
const EXPECTED_TOOL_NAMES = [
  "prepare_withdraw", "submit_withdraw",
  "get_position_performance", "get_pool_activity", "get_position_range_status", "list_rwa_pairs", "list_positions",
  "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction",
  "submit_signed_transaction", "submit_compound_transaction", "quote_open_position", "prepare_open_position", "submit_open_position",
];

describe("tools/list wire contract", () => {
  it("lists exactly the 16 tools in the current order, without authentication", async () => {
    const { response, json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ jsonrpc: "2.0", id: 1 });
    expect(json.result.tools.map((tool: { name: string }) => tool.name)).toEqual(EXPECTED_TOOL_NAMES);
  });

  it("matches the golden snapshot (names, descriptions, input schemas). Update only on a deliberate contract change", async () => {
    const { json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(json.result).toMatchSnapshot();
  });

  it("every tool has a non-empty description and an object inputSchema", async () => {
    const { json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const tool of json.result.tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  const zodFor: Record<string, keyof typeof schemas> = {
    prepare_withdraw:"prepareWithdrawSchema",submit_withdraw:"submitWithdrawSchema",
    get_position_performance: "getPositionPerformanceSchema", get_pool_activity: "getPoolActivitySchema",
    get_position_range_status: "getPositionRangeStatusSchema", list_rwa_pairs: "listRwaPairsSchema",
    list_positions: "listPositionsSchema", quote_add_liquidity: "quoteAddLiquiditySchema",
    prepare_transaction: "prepareTransactionSchema", quote_compound: "quoteCompoundSchema",
    prepare_compound_transaction: "quoteCompoundSchema", submit_signed_transaction: "submitSignedTransactionSchema",
    submit_compound_transaction: "submitCompoundTransactionSchema", quote_open_position: "quoteOpenPositionSchema",
    prepare_open_position: "prepareOpenPositionSchema", submit_open_position: "submitOpenPositionSchema",
  };
  it("the hand-written JSON schemas list the same properties and required fields as the zod schemas that actually validate calls", async () => {
    const { json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    for (const tool of json.result.tools) {
      const schema = schemas[zodFor[tool.name]!] as unknown as {
        shape: Record<string, unknown>; safeParse(value: unknown): { success: boolean };
      };
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort(), tool.name).toEqual(Object.keys(schema.shape).sort());
      // A key is "required" when the schema rejects an otherwise valid call that omits it.
      const valid = VALID_ARGS[tool.name] as Record<string, unknown>;
      expect(schema.safeParse(valid).success, tool.name).toBe(true);
      const required = Object.keys(valid).filter((key) => {
        // Percent/target are conditionally required through oneOf, not top-level required.
        if (tool.name === "prepare_withdraw" && ["percent","targetUSDC"].includes(key)) return false;
        const { [key]: _omitted, ...rest } = valid;
        void _omitted;
        return !schema.safeParse(rest).success;
      }).sort();
      expect([...(tool.inputSchema.required ?? [])].sort(), tool.name).toEqual(required);
    }
  });
});

// -------------------------------------------------------------------- JSON-RPC envelope + auth
describe("JSON-RPC envelope", () => {
  it.each([false, true])("accepts the initialized notification with an empty 202 response (authenticated: %s)", async (authenticated) => {
    const response = await POST(rpc(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      authenticated ? bearer(goodToken()) : {},
    ));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
    expect(toolFns.listPositions).not.toHaveBeenCalled();
  });

  it("initialize and ping are public", async () => {
    const init = await send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    expect(init.json.result).toMatchObject({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sofinance-mcp-server", version: "0.1.0" } });
    expect((await send({ jsonrpc: "2.0", id: 2, method: "ping" })).json).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });

  it("a missing id is echoed as null", async () => {
    expect((await send({ jsonrpc: "2.0", method: "ping" })).json.id).toBeNull();
  });

  it("invalid JSON => 400 / -32700", async () => {
    const { response, json } = await send("{nope");
    expect(response.status).toBe(400);
    expect(json.error).toMatchObject({ code: -32700, message: "Parse error: Invalid JSON" });
  });

  it("wrong jsonrpc version => 400 / -32600", async () => {
    const { response, json } = await send({ jsonrpc: "1.0", id: 3, method: "ping" });
    expect(response.status).toBe(400);
    expect(json.error).toMatchObject({ code: -32600 });
    expect(json.id).toBe(3);
  });

  it("QUIRK: a JSON null body falls into the outer catch: 500 / -32603 with the raw TypeError text", async () => {
    const { response, json } = await send("null");
    expect(response.status).toBe(500);
    expect(json.error.code).toBe(-32603);
    expect(json.error.message).toMatch(/^Internal error: Cannot read properties of null/);
  });

  it("OPTIONS answers CORS preflight; QUIRK: POST responses carry no CORS headers", async () => {
    const options = await OPTIONS();
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(options.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    expect(options.headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
    const { response } = await send({ jsonrpc: "2.0", id: 1, method: "ping" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("authentication", () => {
  const call = { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "list_positions", arguments: { wallet } } };

  it("tools/call without a bearer header => 401 / -32001", async () => {
    const { response, json } = await send(call);
    expect(response.status).toBe(401);
    expect(json.error).toMatchObject({ code: -32001, message: "Unauthorized: Bearer token required" });
  });

  it("a non-Bearer scheme or lower-case 'bearer' is rejected (case-sensitive)", async () => {
    expect((await send(call, { Authorization: `Basic ${goodToken()}` })).response.status).toBe(401);
    expect((await send(call, { Authorization: `bearer ${goodToken()}` })).response.status).toBe(401);
  });

  it("garbage, wrong-secret and expired tokens => 401 / invalid-or-expired", async () => {
    for (const token of ["garbage", generateMcpToken(wallet, "another-secret"), generateMcpToken(wallet, SIGNING_SECRET, -1)]) {
      const { response, json } = await send(call, bearer(token));
      expect(response.status).toBe(401);
      expect(json.error.message).toBe("Unauthorized: Invalid or expired token");
    }
    expect(toolFns.listPositions).not.toHaveBeenCalled();
  });

  it("QUIRK: the server secret is JUPITER_API_KEY; if it is unset, authenticated methods return 500 / 'Server configuration error'", async () => {
    const token = goodToken();
    vi.stubEnv("JUPITER_API_KEY", undefined);
    const { response, json } = await send(call, bearer(token));
    expect(response.status).toBe(500);
    expect(json.error).toMatchObject({ code: -32002, message: "Server configuration error" });
  });

  it("QUIRK: rotating JUPITER_API_KEY invalidates every outstanding MCP token", async () => {
    const token = goodToken();
    vi.stubEnv("JUPITER_API_KEY", "rotated");
    expect((await send(call, bearer(token))).response.status).toBe(401);
  });

  it("QUIRK: an unknown method is 401 when unauthenticated, and 404 / -32601 only after auth", async () => {
    expect((await send({ jsonrpc: "2.0", id: 1, method: "resources/list" })).response.status).toBe(401);
    const { response, json } = await send({ jsonrpc: "2.0", id: 1, method: "resources/list" }, bearer(goodToken()));
    expect(response.status).toBe(404);
    expect(json.error).toMatchObject({ code: -32601, message: "Method not found: resources/list" });
  });

  it("tools/call param validation: name required and must be a string => 400 / -32602", async () => {
    for (const params of [undefined, null, "x", {}, { name: 5 }]) {
      const { response, json } = await send({ jsonrpc: "2.0", id: 1, method: "tools/call", params }, bearer(goodToken()));
      expect(response.status).toBe(400);
      expect(json.error.code).toBe(-32602);
    }
  });
});

// -------------------------------------------------------------------- wallet binding
const VALID_ARGS: Record<string, unknown> = {
  prepare_withdraw:{wallet,positionMint:mint,percent:100},
  submit_withdraw:{wallet,signedTransaction:"AA",permit:"p",summary:{}},
  list_positions: { wallet },
  quote_add_liquidity: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  prepare_transaction: { wallet, positionMint: mint, inputMint: mint, inputKind: "token", amount: "1" },
  quote_compound: { wallet, positionMint: mint },
  prepare_compound_transaction: { wallet, positionMint: mint },
  submit_signed_transaction: {
    signedTransaction: "AA", permit: "p", wallet, selection: { positionMint: mint, inputMint: mint, inputKind: "token" },
    requested: "1", expectedLiquidity: "1", startingLiquidity: "1", floorBps: 9900, expiresAt: 1, lastValidBlockHeight: 1,
    rangeSide: "inside", startingBalances: { input: "1", a: "1", b: "1" },
  },
  submit_compound_transaction: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  quote_open_position: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1" },
  prepare_open_position: { wallet, poolId: pool, inputMint: mint, inputKind: "token", amount: "1" },
  submit_open_position: { signedTransaction: "AA", permit: "p", wallet, summary: {} },
  get_position_performance: { positionMint: mint, wallet },
  get_position_range_status: { positionMint: mint, wallet },
  get_pool_activity: { poolId: pool },
  list_rwa_pairs: {},
};
const IMPLEMENTATION: Record<string, string> = {
  prepare_withdraw:"prepareWithdraw",submit_withdraw:"submitWithdrawTransaction",
  list_positions: "listPositions", quote_add_liquidity: "quoteAddLiquidity", prepare_transaction: "prepareTransaction",
  quote_compound: "quoteCompound", prepare_compound_transaction: "prepareCompoundTransaction",
  submit_signed_transaction: "submitSignedTransaction", submit_compound_transaction: "submitCompoundTransaction",
  quote_open_position: "quoteOpenPosition", prepare_open_position: "prepareOpenPosition", submit_open_position: "submitOpenPosition",
  get_position_performance: "getPositionPerformance", get_position_range_status: "getPositionRangeStatus",
  get_pool_activity: "getPoolActivity", list_rwa_pairs: "listRwaPairs",
};
const WALLET_REQUIRED = EXPECTED_TOOL_NAMES.filter((name) => !["get_position_performance", "get_position_range_status", "get_pool_activity", "list_rwa_pairs"].includes(name));

describe("tools/call dispatch and wallet binding", () => {
  it("covers all 16 tools", () => {
    expect(Object.keys(VALID_ARGS).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
    expect(Object.keys(IMPLEMENTATION).sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it.each(EXPECTED_TOOL_NAMES)("%s: a valid call runs the implementation and wraps the result as pretty-printed JSON text", async (name) => {
    const { response, json } = await callTool(name, VALID_ARGS[name]);
    expect(response.status).toBe(200);
    expect(json.result.isError).toBeUndefined();
    expect(json.result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }, null, 2) }]);
    expect(toolFns[IMPLEMENTATION[name]!]).toHaveBeenCalledOnce();
  });

  it.each(WALLET_REQUIRED)("%s: a wallet different from the token's wallet is refused before the implementation runs", async (name) => {
    const args = { ...(VALID_ARGS[name] as object), wallet: otherWallet };
    const { response, json } = await callTool(name, args);
    expect(response.status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(JSON.parse(json.result.content[0].text)).toEqual({ error: `Token wallet mismatch: token is for ${wallet}, requested ${otherWallet}` });
    expect(toolFns[IMPLEMENTATION[name]!]).not.toHaveBeenCalled();
  });

  it.each(["get_position_performance", "get_position_range_status"])("%s: optional wallet is bound when present, and may be omitted", async (name) => {
    const mismatch = await callTool(name, { ...(VALID_ARGS[name] as object), wallet: otherWallet });
    expect(mismatch.json.result.isError).toBe(true);
    expect(toolFns[IMPLEMENTATION[name]!]).not.toHaveBeenCalled();
    const omitted = await callTool(name, { positionMint: mint });
    expect(omitted.json.result.isError).toBeUndefined();
    expect(toolFns[IMPLEMENTATION[name]!]).toHaveBeenCalledOnce();
  });

  it("QUIRK: the passed wallet is whatever the token holds; get_pool_activity / list_rwa_pairs take no wallet and are unbound", async () => {
    const other = generateMcpToken(otherWallet, SIGNING_SECRET);
    expect((await callTool("get_pool_activity", { poolId: pool }, other)).json.result.isError).toBeUndefined();
    expect((await callTool("list_rwa_pairs", undefined, other)).json.result.isError).toBeUndefined();
  });

  it("QUIRK: a token for wallet B cannot use wallet A's tools (symmetry check of the binding)", async () => {
    const other = generateMcpToken(otherWallet, SIGNING_SECRET);
    const { json } = await callTool("list_positions", { wallet }, other);
    expect(json.result.isError).toBe(true);
    expect(toolFns.listPositions).not.toHaveBeenCalled();
  });

  it("QUIRK: binding is a plain string comparison; schemas accept any 32-44 char base58-looking string as a wallet", async () => {
    const { json } = await callTool("list_positions", { wallet: "1".repeat(32) });
    expect(JSON.parse(json.result.content[0].text).error).toContain("Token wallet mismatch");
  });

  it("zod validation errors come back as isError text (HTTP 200) containing the raw zod message", async () => {
    const { response, json } = await callTool("quote_add_liquidity", { wallet, positionMint: mint });
    expect(response.status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(JSON.parse(json.result.content[0].text).error).toContain("inputMint");
    expect(toolFns.quoteAddLiquidity).not.toHaveBeenCalled();
  });

  it("QUIRK: list_positions with no arguments object fails zod (args are not defaulted) while the optional tools default to {}", async () => {
    expect((await callTool("list_positions", undefined)).json.result.isError).toBe(true);
    expect((await callTool("list_rwa_pairs", undefined)).json.result.isError).toBeUndefined();
    expect(toolFns.listRwaPairs).toHaveBeenCalledWith({ minTvl: 0, maxPages: 3, sortBy: "estimatedFeeApr" });
  });

  it("an unknown tool name is an isError result (HTTP 200), not a JSON-RPC error", async () => {
    const { response, json } = await callTool("does_not_exist", {});
    expect(response.status).toBe(200);
    expect(json.result.isError).toBe(true);
    expect(JSON.parse(json.result.content[0].text)).toEqual({ error: "Unknown tool: does_not_exist" });
  });

  it("STEP 2a: tool errors are sanitized like the web routes: URLs and api keys never reach the agent", async () => {
    toolFns.quoteCompound!.mockRejectedValue(new Error("upstream failed https://api.example/quote?api_key=SECRET123"));
    const { json } = await callTool("quote_compound", VALID_ARGS.quote_compound);
    expect(json.result.isError).toBe(true);
    const text = json.result.content[0].text as string;
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("api.example");
    expect(JSON.parse(text)).toEqual({ error: "upstream failed [redacted]" });
  });

  it.each([
    ["key=value pair", "bad request api_key=SECRET123 end", "bad request [redacted] end"],
    ["api-key header style", "rejected api-key: SECRET123", "rejected [redacted]"],
    ["authorization", "authorization=Bearer SECRET123", "[redacted]"],
    ["token", "token: SECRET123", "[redacted]"],
  ])("STEP 2a: redacts a %s", async (_label, raw, expected) => {
    toolFns.listRwaPairs!.mockRejectedValue(new Error(raw));
    const { json } = await callTool("list_rwa_pairs", {});
    const error = JSON.parse(json.result.content[0].text).error as string;
    expect(error).toBe(expected);
  });

  it("STEP 2a: known chain errors get the same public wording as the web routes; rate limits hide the upstream", async () => {
    toolFns.listRwaPairs!.mockRejectedValue(new Error("Transaction simulation failed: Blockhash not found"));
    expect(JSON.parse((await callTool("list_rwa_pairs", {})).json.result.content[0].text).error).toContain("Transaction blockhash expired.");
    toolFns.listRwaPairs!.mockRejectedValue(new Error("429 Too Many Requests from https://rpc.example/?api-key=SECRET123"));
    const text = (await callTool("list_rwa_pairs", {})).json.result.content[0].text as string;
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("rpc.example");
  });

  it("STEP 2a: a long error is truncated to 220 characters", async () => {
    toolFns.listRwaPairs!.mockRejectedValue(new Error("x".repeat(500)));
    const error = JSON.parse((await callTool("list_rwa_pairs", {})).json.result.content[0].text).error as string;
    expect(error).toHaveLength(220);
    expect(error.endsWith("...")).toBe(true);
  });

  it("STEP 2a: an error with no message falls back to a generic text", async () => {
    toolFns.listRwaPairs!.mockRejectedValue(new Error(""));
    expect(JSON.parse((await callTool("list_rwa_pairs", {})).json.result.content[0].text)).toEqual({ error: "Tool call failed" });
  });

  it("STEP 2a: zod errors stay readable (field paths + messages), not cut to the first 220 chars of JSON", async () => {
    const { json } = await callTool("prepare_transaction", {});
    const error = JSON.parse(json.result.content[0].text).error as string;
    expect(error.startsWith("Invalid arguments: ")).toBe(true);
    for (const field of ["wallet", "positionMint", "inputMint", "amount"]) expect(error).toContain(field);
    expect(error).not.toContain("\n");
  });

  it("STEP 2a: wallet-binding and unknown-tool messages are unchanged by sanitizing", async () => {
    const mismatch = await callTool("list_positions", { wallet: otherWallet });
    expect(JSON.parse(mismatch.json.result.content[0].text).error).toBe(
      `Token wallet mismatch: token is for ${wallet}, requested ${otherWallet}`,
    );
  });

  it("STEP 2a: the outer 'Internal error' catch is sanitized too", async () => {
    const hostile = {
      headers: new Headers(),
      json: async () => ({ jsonrpc: "2.0", id: 1, get method(): string { throw new Error("boom https://rpc.example/?api_key=SECRET123"); } }),
    };
    const response = await POST(hostile as unknown as NextRequest);
    const text = await response.text();
    expect(response.status).toBe(500);
    expect(text).not.toContain("SECRET123");
    expect(JSON.parse(text).error).toEqual({ code: -32603, message: "Internal error: boom [redacted]" });
  });

  it("QUIRK: a non-Error throw is stringified", async () => {
    toolFns.listRwaPairs!.mockRejectedValue("plain string failure");
    const { json } = await callTool("list_rwa_pairs", {});
    expect(JSON.parse(json.result.content[0].text)).toEqual({ error: "plain string failure" });
  });
});
