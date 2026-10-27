// Real tool handlers through both transports. Only builders/read backends are mocked;
// permit, sign-token creation, projection and JSON serialization remain real.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { createHmac } from "node:crypto";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const backend = vi.hoisted(() => ({ discover: vi.fn(), selectedQuote: vi.fn(), selectedBuild: vi.fn(), compound: vi.fn(),
  openQuote: vi.fn(), openBuild: vi.fn(), withdraw: vi.fn(), pairs: vi.fn(), performance: vi.fn(), activity: vi.fn(), range: vi.fn(), rpc: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: backend.discover }));
vi.mock("@/lib/selected-quote", () => ({ searchSelectedQuoteBundle: backend.selectedQuote }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: backend.selectedBuild }));
vi.mock("@sofinance/engine/compound-atomic", () => ({ buildAndSimulateCompound: backend.compound }));
vi.mock("@sofinance/engine/open-quote", () => ({ getOpenPositionQuoteBundle: backend.openQuote }));
vi.mock("@sofinance/engine/open-atomic", () => ({ buildAndSimulateOpenPosition: backend.openBuild }));
vi.mock("@sofinance/engine/withdraw/build", () => ({ buildWithdraw: backend.withdraw }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: backend.pairs }));
vi.mock("@/lib/position-performance", () => ({ getPositionPerformance: backend.performance }));
vi.mock("@/lib/solami-blur", () => ({ getPoolActivitySnapshot: backend.activity }));
vi.mock("@/lib/position-range-onchain", () => ({ readPositionRangeFacts: backend.range }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc }));
import { POST } from "@/app/api/mcp/route";
import { createMcpServer } from "./create-server";
import { generateMcpToken } from "@/lib/mcp-auth";
import { verifySignToken } from "@/lib/pending-sign-token";
import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { VALID_ARGS, wallet, otherWallet } from "./test-support/dispatch-fixtures";

const names = ["list_positions", "quote_add_liquidity", "prepare_transaction", "quote_compound", "prepare_compound_transaction",
  "quote_open_position", "prepare_open_position", "prepare_withdraw", "get_position_performance", "get_position_range_status", "get_pool_activity", "list_rwa_pairs"] as const;
const expectedIO = {
  list_positions: ["discover"], quote_add_liquidity: ["selectedQuote"], prepare_transaction: ["selectedBuild"],
  quote_compound: ["compound"], prepare_compound_transaction: ["compound"], quote_open_position: ["openQuote"],
  prepare_open_position: ["openBuild"], prepare_withdraw: ["withdraw"], get_position_performance: ["performance"],
  get_position_range_status: ["range", "activity"], get_pool_activity: ["activity"], list_rwa_pairs: ["pairs"],
};
const transaction = buildTransaction({ payer: testKeypair(1), signWith: [] });
const summary = {
  operation: "fixture", simulated: true, quote: { wallet, requested: "1", liquidity: "2", floorBps: 9900, rangeSide: "inside", toleranceBps: 100 },
  startingLiquidity: "1", startingBalances: { input: "10", a: "0", b: "0" },
  expiresAt: 1793100060000, lastValidBlockHeight: 150, preserved: { fullSummary: true },
};
let client: Client;
let server: ReturnType<typeof createMcpServer>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1793100000000);
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.invalid.example");
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.discover.mockResolvedValue({ wallet, positions: [], assets: [], slot: 1, fetchedAt: 2 });
  backend.selectedQuote.mockResolvedValue({ quote: summary.quote });
  for (const mock of [backend.selectedBuild, backend.compound, backend.openBuild]) mock.mockResolvedValue({ summary, transaction });
  backend.openQuote.mockResolvedValue({ quote: summary.quote });
  backend.withdraw.mockResolvedValue({ summary, unsignedTransaction: toBase64(transaction), permit: "fixture-permit" });
  backend.pairs.mockResolvedValue({ pairs: [], source: "synthetic", scannedPools: 0, pagesFetched: 1 });
  backend.performance.mockResolvedValue({ positionMint: VALID_ARGS.get_position_performance.positionMint, metrics: { holdingDays: 1 }, history: [] });
  backend.activity.mockResolvedValue({ available: false, pool: null, trades: [] });
  backend.range.mockResolvedValue({ poolId: VALID_ARGS.get_pool_activity.poolId, mintA: wallet, mintB: otherWallet,
    tickLower: -60, tickUpper: 60, decimalsA: 9, decimalsB: 9, onChainPriceBPerA: 1 });
  server = createMcpServer(); client = new Client({ name: "real-handlers", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
  expect(Object.values(backend).every(fn => fn.mock.calls.length === 0)).toBe(true);
});
afterEach(async () => {
  await client?.close(); await server?.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});
async function call(surface: "http" | "stdio", name: string, args: unknown) {
  if (surface === "stdio") return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
  const response = await POST(new NextRequest("http://localhost/api/mcp", {
    method: "POST", headers: { Authorization: `Bearer ${generateMcpToken(wallet, SIGNING_SECRET)}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }));
  expect(response.status).toBe(200); return CallToolResultSchema.parse((await response.json()).result);
}
function io() {
  return Object.entries(backend).flatMap(([name, fn]) => fn.mock.calls.map((args, i) => ({ name, args, order: fn.mock.invocationCallOrder[i]! })))
    .sort((a, b) => a.order - b.order).map(({ name, args }) => ({ name, args }));
}
async function snapshotResult(result: Awaited<ReturnType<typeof call>>) {
  const first = result.content[0];
  if (first?.type !== "text") return result;
  const value = JSON.parse(first.text);
  if (typeof value.signToken !== "string") return result;
  const token: string = value.signToken;
  const payload = await verifySignToken(token, SIGNING_SECRET);
  expect(payload).not.toBeNull();
  expect(value.signUrl).toBe(`https://app.invalid.example/app/sign/${token}`);
  expect(await verifySignToken(token, `${SIGNING_SECRET}-wrong`)).toBeNull();
  const tampered = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
  expect(await verifySignToken(tampered, SIGNING_SECRET)).toBeNull();
  // Deflate output varies between Node/zlib builds. Retain the entire authenticated
  // payload and all surrounding response bytes, rather than snapshotting compression.
  const normalized = `verified-payload:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return { ...result, content: [{ ...first, text: first.text.replaceAll(token, normalized) }, ...result.content.slice(1)] };
}
for (const surface of ["http", "stdio"] as const) describe(`${surface} real read/prepare handlers`, () => {
  it.each(names)("%s preserves backend arguments, count/order, response and authenticated sign payload", async name => {
    const result = await call(surface, name, { ...VALID_ARGS[name], ignored: "stripped" });
    expect(result.isError).toBeUndefined();
    expect(io().map(item => item.name)).toEqual(expectedIO[name]);
    const normalized = await snapshotResult(result);
    expect({ result: normalized, io: io() }).toMatchSnapshot();
    const first = result.content[0];
    if (first?.type === "text") {
      const value = JSON.parse(first.text);
      if (value.signToken) {
        const payload = await verifySignToken(value.signToken, SIGNING_SECRET);
        expect(payload?.unsignedTransaction).toBe(toBase64(transaction));
        expect(payload?.wallet).toBe(wallet);
        if (name !== "prepare_transaction") expect(payload?.submitArgs.summary).toEqual(summary);
        // A different valid compression stream must preserve the same contract.
        const data = deflateSync(Buffer.from(JSON.stringify(payload)), { level: 0 }).toString("base64url");
        const alternate = `${createHmac("sha256", SIGNING_SECRET).update(data).digest("base64url")}.${data}`;
        expect(alternate).not.toBe(value.signToken);
        const alternateResult = { ...result, content: [{ ...first, text: first.text.replaceAll(value.signToken, alternate) }, ...result.content.slice(1)] };
        expect(await snapshotResult(alternateResult)).toEqual(normalized);
      }
    }
  });
  if (surface === "http") it.each(names.filter(name => !["get_pool_activity", "list_rwa_pairs"].includes(name)))("%s rejects HTTP wallet mismatch before backend", async name => {
    expect((await call(surface, name, { ...VALID_ARGS[name], wallet: otherWallet })).isError).toBe(true);
    expect(io()).toEqual([]);
  });
  if (surface === "stdio") it("stdio quote remains usable without a signing secret", async () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    expect((await call(surface, "quote_compound", VALID_ARGS.quote_compound)).isError).toBeUndefined();
    expect(io().map(item => item.name)).toEqual(["compound"]);
  });
});
