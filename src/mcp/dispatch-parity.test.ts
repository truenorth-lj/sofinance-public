// Captured against the original switches after registration-only extraction.
// Real HTTP route/auth/Zod and real SDK registered handlers + in-memory transport.
// Handler results are mocked here; tools.submit.test.ts covers the real submit pipelines.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateMcpToken } from "@/lib/mcp-auth";
import { SIGNING_SECRET } from "@/lib/test-support/send-fixtures";
import { IMPLEMENTATION, VALID_ARGS, wallet, otherWallet } from "./test-support/dispatch-fixtures";

const handlers = vi.hoisted(() => ({
  prepareWithdraw: vi.fn(), submitWithdrawTransaction: vi.fn(),
  getPositionPerformance: vi.fn(), getPoolActivity: vi.fn(), getPositionRangeStatus: vi.fn(), listRwaPairs: vi.fn(),
  listPositions: vi.fn(), quoteAddLiquidity: vi.fn(), prepareTransaction: vi.fn(), quoteCompound: vi.fn(),
  prepareCompoundTransaction: vi.fn(), submitSignedTransaction: vi.fn(), submitCompoundTransaction: vi.fn(),
  quoteOpenPosition: vi.fn(), prepareOpenPosition: vi.fn(), submitOpenPosition: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./tools", () => handlers);
import { POST } from "@/app/api/mcp/route";
import { createMcpServer } from "./create-server";

const names = Object.keys(VALID_ARGS) as (keyof typeof VALID_ARGS)[];
const optional = ["get_position_performance", "get_position_range_status"];
const none = ["get_pool_activity", "list_rwa_pairs"];
const resultValue = { ok: true, nested: { values: [1, null, "繁體"], omitted: undefined }, signature: "original-signature" };
let client: Client;
let server: ReturnType<typeof createMcpServer>;
beforeEach(async () => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const handler of Object.values(handlers)) handler.mockReset().mockResolvedValue(resultValue);
  server = createMcpServer();
  client = new Client({ name: "dispatch-parity", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  await client.connect(b);
});
afterEach(async () => {
  await client?.close();
  await server?.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
async function call(surface: "http" | "stdio", name: unknown, args: unknown, authenticated = true): Promise<unknown> {
  if (surface === "http") {
    const response = await POST(new NextRequest("http://localhost/api/mcp", {
      method: "POST", headers: authenticated ? { Authorization: `Bearer ${generateMcpToken(wallet, SIGNING_SECRET)}` } : {},
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }),
    }));
    return { status: response.status, body: await response.json() };
  }
  try {
    return await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
  } catch (error) {
    if (!(error instanceof McpError)) throw error;
    return { protocolError: { code: error.code, message: error.message } };
  }
}
function calls() {
  return Object.fromEntries(Object.entries(handlers).filter(([, fn]) => fn.mock.calls.length).map(([name, fn]) => [name, fn.mock.calls]));
}
function resetCalls() { for (const fn of Object.values(handlers)) fn.mockClear(); }

for (const surface of ["http", "stdio"] as const) describe(surface, () => {
  it.each(names)("%s preserves parsed arguments, exactly one handler, serialization and all rejection variants", async (name) => {
    const valid = VALID_ARGS[name];
    const variants: [string, unknown][] = [
      ["valid", { ...valid, ignored: true, surface: "mcp-stdio", tokenWallet: otherWallet }],
      ["undefined", undefined], ["null", null], ["empty", {}], ["string", "malformed"], ["array", []],
      ["wrong wallet", { ...valid, wallet: otherWallet }],
      ["invalid wallet", { ...valid, wallet: "invalid" }],
      ["invalid schema and mismatched wallet", { wallet: otherWallet, positionMint: "bad", amount: false }],
      ["omitted wallet", Object.fromEntries(Object.entries(valid).filter(([key]) => key !== "wallet"))],
    ];
    const observations = [];
    for (const [label, args] of variants) {
      resetCalls();
      const response = await call(surface, name, args);
      const invoked = calls();
      observations.push({ label, response, calls: invoked });
      if (label === "valid") {
        expect(Object.keys(invoked)).toEqual([IMPLEMENTATION[name]]);
        expect(handlers[IMPLEMENTATION[name]]).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(response)).toContain("original-signature");
      }
      if (label === "wrong wallet" && surface === "http" && !none.includes(name)) expect(invoked).toEqual({});
      if (label === "omitted wallet" && optional.includes(name)) {
        expect(handlers[IMPLEMENTATION[name]]).toHaveBeenCalledOnce();
        expect(handlers[IMPLEMENTATION[name]].mock.calls[0]![0]).not.toHaveProperty("wallet");
      }
    }
    expect(observations).toMatchSnapshot();
  });

  it.each(["unknown", "__proto__", "constructor", "toString", "hasOwnProperty", "", null, 42, {}, ["list_positions"]])("unknown name %j keeps the protocol contract", async name => {
    expect(await call(surface, name, {})).toMatchSnapshot();
    expect(calls()).toEqual({});
  });

  it.each(names)("%s preserves backend error sanitization and serialization failure", async name => {
    const fn = handlers[IMPLEMENTATION[name]];
    const observations = [];
    for (const error of [new Error("upstream https://rpc.example/path?api-key=SECRET token: SECRET"), new Error("Unknown send; reconcile original-signature"), undefined]) {
      resetCalls(); fn.mockRejectedValueOnce(error);
      observations.push(await call(surface, name, VALID_ARGS[name]));
      expect(Object.keys(calls())).toEqual([IMPLEMENTATION[name]]);
      expect(fn).toHaveBeenCalledOnce();
    }
    resetCalls(); fn.mockResolvedValueOnce({ amount: 1n });
    observations.push(await call(surface, name, VALID_ARGS[name]));
    expect(fn).toHaveBeenCalledOnce();
    expect(observations).toMatchSnapshot();
    expect(JSON.stringify(observations)).not.toContain("SECRET");
  });

  it("preserves withdraw transform/refine and compound source signatures", async () => {
    const observations = [];
    for (const [name, args] of [
      ["prepare_withdraw", { ...VALID_ARGS.prepare_withdraw, wallet: ` ${wallet} ` }],
      ["prepare_withdraw", { ...VALID_ARGS.prepare_withdraw, targetUSDC: 1 }],
      ["prepare_withdraw", { ...VALID_ARGS.prepare_withdraw, stage: "swap", tx1Signature: "tx1", previous: { preserved: true } }],
      ["prepare_compound_transaction", { ...VALID_ARGS.prepare_compound_transaction, sourceSignatures: ["1".repeat(88), "1".repeat(88)] }],
    ] as const) {
      resetCalls(); observations.push({ response: await call(surface, name, args), calls: calls() });
    }
    expect(observations).toMatchSnapshot();
  });
});
it.each(names)("HTTP %s requires a token before any handler, including no-wallet tools", async name => {
  expect(await call("http", name, VALID_ARGS[name], false)).toMatchObject({ status: 401 });
  expect(calls()).toEqual({});
});
