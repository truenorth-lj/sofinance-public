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
  openQuote: vi.fn(), openBuild: vi.fn(), withdraw: vi.fn(), pairs: vi.fn(), performance: vi.fn(), activity: vi.fn(), range: vi.fn(), rpc: vi.fn(), latest: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: backend.discover }));
vi.mock("@/lib/selected-quote", () => ({ searchSelectedQuoteBundle: backend.selectedQuote }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: backend.selectedBuild }));
vi.mock("@sofinance/engine/compound-atomic", () => ({ buildAndSimulateCompound: backend.compound }));
vi.mock("@sofinance/engine/open-quote", () => ({ getOpenPositionQuoteBundle: backend.openQuote }));
vi.mock("@sofinance/engine/open-atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/open-atomic")>()),
  buildAndSimulateOpenPosition: backend.openBuild,
}));
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

const transaction = buildTransaction({ payer: testKeypair(1), signWith: [] });
const summary = {
  operation: "fixture", wallet, simulated: true, quote: { wallet, requested: "1", liquidity: "2", floorBps: 9900, rangeSide: "inside", toleranceBps: 100 },
  startingLiquidity: "1", startingBalances: { input: "10", a: "0", b: "0" },
  expiresAt: 1793100060000, lastValidBlockHeight: 150, preserved: { fullSummary: true },
};
let client: Client;
let server: ReturnType<typeof createMcpServer>;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1793100000000);
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.invalid.example");
  vi.spyOn(performance, "now").mockReturnValue(100);
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const mock of Object.values(backend)) mock.mockReset();
  backend.discover.mockResolvedValue({ wallet, positions: [], assets: [], slot: 1, fetchedAt: 2 });
  backend.selectedQuote.mockResolvedValue({ quote: summary.quote });
  for (const mock of [backend.selectedBuild, backend.compound, backend.openBuild]) mock.mockResolvedValue({ summary, transaction });
  backend.openQuote.mockResolvedValue({ quote: summary.quote });
  backend.withdraw.mockResolvedValue({ summary, unsignedTransaction: toBase64(transaction), permit: "fixture-permit" });
  backend.rpc.mockReturnValue({ getLatestBlockhash: backend.latest });
  backend.latest.mockResolvedValue({ blockhash: testKeypair(90).publicKey.toBase58(), lastValidBlockHeight: 180 });
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
    .sort((a, b) => a.order - b.order).map(({ name, args }) => ({ name, args: args.map(arg => arg && typeof arg === "object" && "signal" in arg ? { ...arg, signal: { aborted: arg.signal.aborted } } : arg) }));
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
  const data = deflateSync(Buffer.from(JSON.stringify(payload)), { level: 0 }).toString("base64url");
  const alternate = `${createHmac("sha256", SIGNING_SECRET).update(data).digest("base64url")}.${data}`;
  expect(alternate).not.toBe(token);
  expect(await verifySignToken(alternate, SIGNING_SECRET)).toEqual(payload);
  // Deflate output varies between Node/zlib builds. Retain the entire authenticated
  // payload and all surrounding response bytes, rather than snapshotting compression.
  const normalized = `verified-payload:${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return { ...result, content: [{ ...first, text: first.text.replaceAll(token, normalized) }, ...result.content.slice(1)] };
}

import { POST as compound } from "@/app/api/compound-prepare/route";
import { POST as selected } from "@/app/api/selected-prepare/route";
import { POST as open } from "@/app/api/open-prepare/route";
import { POST as withdraw } from "@/app/api/withdraw-prepare/route";
import { jupiterRelayActive, jupiterRequest, setJupiterRelayHint } from "@sofinance/engine/jupiter/client";
import { withdrawPrepareSchema } from "@sofinance/engine/withdraw/input";
import { TRANSIENT_BUILD_ERRORS } from "@/lib/withdraw/retry";
import { OPEN_FEE_ESTIMATE_MESSAGE } from "@/lib/rpc-fee-estimate";
import { jsonRequest } from "@/lib/test-support/send-fixtures";
import * as selectedPermit from "@/lib/selected-permit";

const cases = [
  { kind: "compound", route: compound, name: "prepare_compound_transaction", build: backend.compound },
  { kind: "selected", route: selected, name: "prepare_transaction", build: backend.selectedBuild },
  { kind: "open", route: open, name: "prepare_open_position", build: backend.openBuild },
  { kind: "withdraw", route: withdraw, name: "prepare_withdraw", build: backend.withdraw },
] as const;
async function app(route: typeof compound, body: unknown, signal?: AbortSignal) {
  const response = await route(jsonRequest("http://localhost/api/prepare", body, { signal }));
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
}
for (const c of cases) describe(`${c.kind} prepare baseline`, () => {
  it("HTTP preserves full output, permit, bytes, headers and I/O", async () => {
    expect({ result: await app(c.route, { ...VALID_ARGS[c.name], ignored: "preserved-only-for-withdraw" }), io: io() }).toMatchSnapshot();
  });
  it.each([null, [], {}, { wallet: "invalid" }])("HTTP request/error precedence %j", async body => {
    if (c.kind === "withdraw") backend.withdraw.mockImplementation(async raw => { withdrawPrepareSchema.parse(raw); throw new Error("unreachable"); });
    expect({ result: await app(c.route, body), io: io() }).toMatchSnapshot();
  });
  it("HTTP builder failure precedes missing signing key", async () => {
    vi.stubEnv("JUPITER_API_KEY", undefined);
    c.build.mockRejectedValue(new Error("fixture builder rejected"));
    expect({ result: await app(c.route, VALID_ARGS[c.name]), io: io() }).toMatchSnapshot();
  });
  for (const surface of ["http", "stdio"] as const) {
    it(`${surface} MCP has no HTTP outer retry or refresh`, async () => {
      c.build.mockRejectedValue(new Error(OPEN_FEE_ESTIMATE_MESSAGE));
      expect({ result: await call(surface, c.name, VALID_ARGS[c.name]), io: io() }).toMatchSnapshot();
      expect(c.build).toHaveBeenCalledOnce(); expect(backend.latest).not.toHaveBeenCalled();
    });
    it.each(["explicit", "vercel", "relative"])(`${surface} sign URL %s preserves the entire authenticated payload`, async origin => {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", origin === "explicit" ? " https://app.invalid.example/ " : undefined);
      vi.stubEnv("VERCEL_URL", origin === "vercel" ? "preview.invalid.example" : undefined);
      const result = await call(surface, c.name, VALID_ARGS[c.name]);
      const first = result.content[0]; expect(first?.type).toBe("text");
      if (first?.type !== "text") throw new Error("missing text");
      const value = JSON.parse(first.text);
      const prefix = origin === "explicit" ? "https://app.invalid.example" : origin === "vercel" ? "https://preview.invalid.example" : "";
      expect(value.signUrl).toBe(`${prefix}/app/sign/${value.signToken}`);
      // Reuse the authenticated normalization (including wrong key/tamper checks).
      const normalizedInput = { ...result, content: [{ ...first, text: first.text.replace(value.signUrl, `https://app.invalid.example/app/sign/${value.signToken}`) }] };
      expect({ result: await snapshotResult(normalizedInput), origin: prefix, io: io() }).toMatchSnapshot();
    });
  }
});

it("compound HTTP deduplicates sources by rejection while MCP preserves duplicates", async () => {
  const body = { ...VALID_ARGS.prepare_compound_transaction, sourceSignatures: ["1".repeat(88), "1".repeat(88)] };
  expect({ result: await app(compound, body), io: io() }).toMatchSnapshot("http");
  expect(backend.compound).not.toHaveBeenCalled();
  expect({ result: await snapshotResult(await call("stdio", "prepare_compound_transaction", body)), io: io() }).toMatchSnapshot("stdio");
});
it("open HTTP accepts micro while MCP rejects it before building", async () => {
  const body = { ...VALID_ARGS.prepare_open_position, rangePreset: "micro" };
  expect({ result: await app(open, body), io: io() }).toMatchSnapshot("http");
  backend.openBuild.mockClear();
  expect({ result: await call("stdio", "prepare_open_position", body), io: io() }).toMatchSnapshot("stdio");
  expect(backend.openBuild).not.toHaveBeenCalled();
});
it("withdraw passes the entire raw previous object without parsing at HTTP boundary", async () => {
  const body = { ...VALID_ARGS.prepare_withdraw, stage: "swap", tx1Signature: "prior", previous: { summary, unsignedTransaction: toBase64(transaction), permit: "bound-first-stage", extra: { receipt: "full" } }, confirmHighImpact: true, ignored: 42 };
  expect({ result: await app(withdraw, body), io: io() }).toMatchSnapshot("http");
  expect(backend.withdraw).toHaveBeenCalledWith(body);
  backend.withdraw.mockClear(); backend.latest.mockClear(); backend.rpc.mockClear();
  expect({ result: await snapshotResult(await call("stdio", "prepare_withdraw", body)), io: io() }).toMatchSnapshot("stdio");
});
for (const message of TRANSIENT_BUILD_ERRORS) it(`HTTP withdraw retries exactly three: ${message}`, async () => {
  backend.withdraw.mockRejectedValue(new Error(message));
  expect({ result: await app(withdraw, VALID_ARGS.prepare_withdraw), io: io() }).toMatchSnapshot();
  expect(backend.withdraw).toHaveBeenCalledTimes(3); expect(backend.latest).not.toHaveBeenCalled();
});
it.each(["permanent failure", `${OPEN_FEE_ESTIMATE_MESSAGE}!`])("HTTP retry allowlists reject %s", async message => {
  backend.openBuild.mockRejectedValue(new Error(message)); backend.withdraw.mockRejectedValue(new Error(message));
  expect({ open: await app(open, VALID_ARGS.prepare_open_position), withdraw: await app(withdraw, VALID_ARGS.prepare_withdraw), io: io() }).toMatchSnapshot();
  expect(backend.openBuild).toHaveBeenCalledOnce(); expect(backend.withdraw).toHaveBeenCalledOnce();
});
it("HTTP open retries at most three and never issues a permit on failure", async () => {
  backend.openBuild.mockRejectedValue(new Error(OPEN_FEE_ESTIMATE_MESSAGE));
  expect({ result: await app(open, VALID_ARGS.prepare_open_position), io: io() }).toMatchSnapshot();
  expect(backend.openBuild).toHaveBeenCalledTimes(3);
});
it("HTTP withdraw refresh happens only after the successful retry", async () => {
  backend.withdraw.mockRejectedValueOnce(new Error(TRANSIENT_BUILD_ERRORS[0]));
  expect({ result: await app(withdraw, VALID_ARGS.prepare_withdraw), io: io() }).toMatchSnapshot();
  expect(backend.withdraw).toHaveBeenCalledTimes(2); expect(backend.latest).toHaveBeenCalledOnce();
});
for (const c of cases.filter(c => c.kind !== "compound")) {
  it(`${c.kind} preserves relay AsyncLocalStorage and missing-quote 409`, async () => {
    c.build.mockImplementation(async () => {
      await Promise.resolve(); expect(jupiterRelayActive()).toBe(true); setJupiterRelayHint("fixture", 9n);
      await jupiterRequest({ path: "/swap/v1/quote", query: { amount: "1" } });
      throw new Error("unreachable");
    });
    expect({ result: await app(c.route, { ...VALID_ARGS[c.name], jupiterRelay: { responses: {}, hints: { fixture: "7" } } }), io: io() }).toMatchSnapshot();
    expect(jupiterRelayActive()).toBe(false);
  });
  it(`${c.kind} preserves relay success hints`, async () => {
    const original = await c.build(); c.build.mockClear();
    c.build.mockImplementation(async () => { await Promise.resolve(); expect(jupiterRelayActive()).toBe(true); setJupiterRelayHint("fixture", 9n); return original; });
    expect({ result: await app(c.route, { ...VALID_ARGS[c.name], jupiterRelay: { responses: {} } }), io: io() }).toMatchSnapshot();
  });
}
it("selected abort after build skips permit and drains sibling work", async () => {
  const controller = new AbortController(); const permit = vi.spyOn(selectedPermit, "issueSelectedPermit"); let stopped = false;
  backend.selectedBuild.mockImplementation(async (...args) => {
    const signal: AbortSignal = args[5].signal;
    signal.addEventListener("abort", () => { stopped = true; }, { once: true });
    controller.abort(); return { summary, transaction };
  });
  expect(await app(selected, VALID_ARGS.prepare_transaction, controller.signal)).toMatchSnapshot();
  await Promise.resolve(); expect(stopped).toBe(true); expect(permit).not.toHaveBeenCalled();
});
it("selected abort after permit never serializes a transaction", async () => {
  const controller = new AbortController(); const original = selectedPermit.issueSelectedPermit;
  vi.spyOn(selectedPermit, "issueSelectedPermit").mockImplementation((...args) => { const p = original(...args); controller.abort(); return p; });
  const serialize = vi.spyOn(transaction, "serialize");
  expect(await app(selected, VALID_ARGS.prepare_transaction, controller.signal)).toMatchSnapshot();
  await Promise.resolve(); expect(serialize).not.toHaveBeenCalled();
});
it("selected 8 second deadline aborts backend work, keeps retriesLeft1 and returns 504", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1793100000000); let stopped = false;
  backend.selectedBuild.mockImplementation((...args) => new Promise((_, reject) => {
    expect(args[5].budget.retriesLeft).toBe(1);
    expect(args[5].budget.deadlineAt - Date.now()).toBeLessThanOrEqual(8000);
    args[5].signal.addEventListener("abort", () => { stopped = true; reject(args[5].signal.reason); }, { once: true });
  }));
  const pending = app(selected, VALID_ARGS.prepare_transaction);
  // Request.clone().json() drains native streams, so allow that before advancing the timer.
  await vi.waitFor(() => expect(backend.selectedBuild).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(8000);
  expect(await pending).toMatchSnapshot(); expect(stopped).toBe(true); expect(vi.getTimerCount()).toBe(0);
});
