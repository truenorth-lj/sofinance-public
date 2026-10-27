// Frozen on accepted PR154 before extraction. Actual HTTP/registered SDK entrypoints,
// real permits/structure/nacl/simulator/retry wrapper; only backend I/O is synthetic.
import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { PersonalPositionLayout } from "@raydium-io/raydium-sdk-v2";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Connection, PublicKey, SystemProgram, VersionedTransaction, type AccountInfo } from "@solana/web3.js";
import { NextRequest } from "next/server";
import nacl from "tweetnacl";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ rpc: vi.fn(), state: vi.fn(), sim: vi.fn(), invalidate: vi.fn(), beam: vi.fn() }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: backend.state }));
vi.mock("@/lib/position-history-cache", () => ({ invalidatePositionHistoryCache: backend.invalidate }));
vi.mock("@/lib/selected-simulation", async original => {
  const actual = await original<typeof import("@/lib/selected-simulation")>();
  return { simulateAndVerifySelectedTransaction: (...args: Parameters<typeof actual.simulateAndVerifySelectedTransaction>) => {
    backend.sim(...args); return actual.simulateAndVerifySelectedTransaction(...args);
  } };
});
vi.mock("@/lib/beam-after-send", async original => {
  const actual = await original<typeof import("@/lib/beam-after-send")>();
  return { ...actual, beamAfterSend: async (...args: Parameters<typeof actual.beamAfterSend>) => {
    backend.beam(...args); return actual.beamAfterSend(...args);
  } };
});
import { createResilientConnection } from "@sofinance/engine/rpc/connection";
import type { SelectedPositionState } from "@sofinance/engine/selected-state";
import { POST as app } from "@/app/api/selected-broadcast/route";
import { POST as http } from "@/app/api/mcp/route";
import { createMcpServer } from "./create-server";
import { generateMcpToken } from "@/lib/mcp-auth";
import { issueSelectedPermit, type SelectedPermitInput } from "@/lib/selected-permit";
import { SIGNING_SECRET, buildTransaction, testKeypair, signatureOf, messageBase64, toBase64, oversizedSignedBase64, jsonRequest } from "@/lib/test-support/send-fixtures";

type Surface = "app" | "http-mcp" | "sdk";
const NOW = 1793100000000;
const context = new AsyncLocalStorage<string>();
let trace: unknown[], client: Client, server: ReturnType<typeof createMcpServer>;
const contexts: (string | undefined)[] = [];
const record = (...args: unknown[]) => { trace.push(args); contexts.push(context.getStore()); };
function tokenInfo(mint: PublicKey, wallet: PublicKey, amount: bigint): AccountInfo<Buffer> {
  const data = Buffer.alloc(165); mint.toBuffer().copy(data); wallet.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(amount, 64); data.writeUInt8(1, 108);
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 2039280, rentEpoch: 0 };
}
function fixture(seed = 1, native = false) {
  const payer = testKeypair(seed), wallet = payer.publicKey.toBase58();
  const nft = testKeypair(seed + 20).publicKey, pool = testKeypair(seed + 30).publicKey;
  const mintA = testKeypair(50).publicKey, mintB = testKeypair(51).publicKey;
  const input = native ? new PublicKey("So11111111111111111111111111111111111111112") : testKeypair(52).publicKey;
  const nftAta = getAssociatedTokenAddressSync(nft, payer.publicKey), ataA = getAssociatedTokenAddressSync(mintA, payer.publicKey);
  const ataB = getAssociatedTokenAddressSync(mintB, payer.publicKey), inputAta = getAssociatedTokenAddressSync(input, payer.publicKey);
  const tx = buildTransaction({ payer });
  const state: SelectedPositionState = {
    wallet, positionMint: nft.toBase58(), poolId: pool.toBase58(), positionAccount: testKeypair(seed + 40).publicKey.toBase58(),
    programId: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", nftAta: nftAta.toBase58(), nftProgram: TOKEN_PROGRAM_ID.toBase58(),
    mintA: mintA.toBase58(), mintB: mintB.toBase58(), ataA: ataA.toBase58(), ataB: ataB.toBase58(),
    programA: TOKEN_PROGRAM_ID.toBase58(), programB: TOKEN_PROGRAM_ID.toBase58(), inputMint: input.toBase58(),
    inputKind: native ? "native" : "token", inputAccount: inputAta.toBase58(), inputTokenProgram: TOKEN_PROGRAM_ID.toBase58(),
    tickLower: -100, tickUpper: 100, liquidity: "10", slot: 42, ownsNft: true, paused: false, frozen: false,
    transferFee: false, unsupportedExtensions: [], sufficientSol: true, rangeSide: "inside", wsolBalance: "0", solLamports: 100000000,
    balances: { input: native ? "100000000" : "1000", a: "10", b: "5" },
    fetchedAt: NOW, inputDecimals: native ? 9 : 6, inputBalance: native ? "100000000" : "1000",
    ataAExists: true, ataBExists: true, vaultA: testKeypair(60).publicKey.toBase58(), vaultB: testKeypair(61).publicKey.toBase58(),
    tickSpacing: 1, decimalsA: 6, decimalsB: 6, sqrtPriceX64: "18446744073709551616", tickCurrent: 0,
    lowerSqrtX64: "18354745142194483563", upperSqrtX64: "18539204128674405812", price: "1", inRange: true,
    poolLiquidity: "10000", currentAmounts: { a: "10", b: "5" }, pricing: undefined,
  };
  const facts: SelectedPermitInput = { wallet, message: messageBase64(tx),
    selection: { positionMint: state.positionMint, inputMint: state.inputMint, inputKind: state.inputKind },
    requested: "1000", floorBps: 9900, expiresAt: NOW + 60000, lastValidBlockHeight: 150,
    startingLiquidity: "10", expectedLiquidity: "5", rangeSide: "inside", startingBalances: { ...state.balances } };
  const body = { ...facts, permit: issueSelectedPermit(SIGNING_SECRET, facts), signedTransaction: toBase64(tx) };
  const before = new Map([
    [nftAta.toBase58(), tokenInfo(nft, payer.publicKey, 1n)],
    [ataA.toBase58(), tokenInfo(mintA, payer.publicKey, 10n)],
    [ataB.toBase58(), tokenInfo(mintB, payer.publicKey, 5n)],
    [inputAta.toBase58(), tokenInfo(input, payer.publicKey, native ? 0n : 1000n)],
  ]);
  const positionData = Buffer.alloc(PersonalPositionLayout.span);
  nft.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("nftMint"));
  pool.toBuffer().copy(positionData, PersonalPositionLayout.offsetOf("poolId"));
  positionData.writeInt32LE(-100, PersonalPositionLayout.offsetOf("tickLower"));
  positionData.writeInt32LE(100, PersonalPositionLayout.offsetOf("tickUpper"));
  positionData.writeBigUInt64LE(15n, PersonalPositionLayout.offsetOf("liquidity"));
  const height = vi.fn(async (commitment: unknown) => { record("height", wallet, commitment); return 100; });
  const send = vi.fn(async (bytes: Uint8Array, options: unknown) => {
    record("physical-send", wallet, Buffer.from(bytes).toString("base64"), options);
    return signatureOf(VersionedTransaction.deserialize(bytes));
  });
  const physical = {
    getBlockHeight: height,
    getMultipleAccountsInfoAndContext: vi.fn(async (keys: PublicKey[], commitment: unknown) => {
      record("accounts", wallet, keys.map(k => k.toBase58()), commitment);
      return { context: { slot: 42 }, value: keys.map(k => before.get(k.toBase58()) ?? null) };
    }),
    getBalance: vi.fn(async (key: PublicKey, commitment: unknown) => { record("balance", key.toBase58(), commitment); return state.solLamports; }),
    simulateTransaction: vi.fn(async (transaction: VersionedTransaction, options: { sigVerify: boolean; accounts: { addresses: string[] } }) => {
      record("rpc-simulate", wallet, toBase64(transaction), options);
      if (options.sigVerify && !nacl.sign.detached.verify(transaction.message.serialize(), transaction.signatures[0]!, payer.publicKey.toBytes())) {
        return { value: { err: "SignatureFailure", logs: ["synthetic signature rejected"], accounts: null } };
      }
      const after = new Map(before); after.set(inputAta.toBase58(), tokenInfo(input, payer.publicKey, 0n));
      return { value: { err: null, logs: [], accounts: options.accounts.addresses.map(address => {
        if (address === state.positionAccount) return { owner: state.programId, data: [positionData.toString("base64"), "base64"], lamports: 0, executable: false };
        if (address === wallet) return { owner: SystemProgram.programId.toBase58(), data: ["", "base64"], lamports: 99999000, executable: false };
        const info = after.get(address); return info ? { ...info, owner: info.owner.toBase58(), data: [info.data.toString("base64"), "base64"] } : null;
      }), unitsConsumed: 100000 } };
    }),
    sendRawTransaction: send,
  };
  // The incomplete Connection is confined to this offline I/O fixture.
  const connection = physical as unknown as Connection;
  return { wallet, payer, tx, state, facts, body, before, positionData, physical, connection, send, height, nftAta, inputAta };
}
type Fixture = ReturnType<typeof fixture>;
function resignPermit(f: Fixture) { f.body.permit = issueSelectedPermit(SIGNING_SECRET, { ...f.body, message: messageBase64(VersionedTransaction.deserialize(Buffer.from(f.body.signedTransaction, "base64"))) }); }
function install(f: Fixture, connection = f.connection) {
  backend.rpc.mockImplementation(() => { record("connection"); return connection; });
  backend.state.mockImplementation(async (wallet, selection, conn, ...options) => {
    expect(conn).toBe(connection); record("state", wallet, selection, options); return f.state;
  });
}
async function call(surface: Surface, body: unknown, tokenWallet = testKeypair(1).publicKey.toBase58(), signal?: AbortSignal) {
  if (surface === "app") {
    const response = await app(jsonRequest("http://localhost/api/selected-broadcast", body, { signal }));
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
  }
  const params = { name: "submit_signed_transaction", arguments: body };
  if (surface === "sdk") return { result: await client.request({ method: "tools/call", params }, CallToolResultSchema) };
  const response = await http(new NextRequest("http://localhost/api/mcp", { method: "POST", signal,
    headers: { Authorization: `Bearer ${generateMcpToken(tokenWallet, SIGNING_SECRET)}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }));
  return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.json() };
}
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW);
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET); vi.spyOn(console, "error").mockImplementation(() => {});
  trace = []; contexts.length = 0;
  backend.sim.mockImplementation(({ transaction, wallet, requested, expectedLiquidity, sigVerify, ...rest }) => {
    record("simulator", wallet.toBase58(), toBase64(transaction), String(requested), String(expectedLiquidity), sigVerify,
      Object.hasOwn(rest, "useStateSnapshot") ? rest.useStateSnapshot : "omitted");
  });
  backend.invalidate.mockImplementation(position => record("invalidate", position));
  backend.beam.mockImplementation((signature, plan) => record("beam", signature, plan));
  server = createMcpServer(); client = new Client({ name: "selected-submit-contract", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
});
afterEach(async () => { await client?.close(); await server?.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

type Case = { name: string; change?: (f: Fixture) => void; sends?: number; native?: boolean };
const cases: Case[] = [
  { name: "success", sends: 1 }, { name: "native success", native: true, sends: 1 },
  { name: "malformed wallet", change: f => { f.body.wallet = "bad"; } },
  { name: "off-curve wallet", change: f => { f.body.wallet = PublicKey.findProgramAddressSync([Buffer.from("seed")], testKeypair(90).publicKey)[0].toBase58(); } },
  { name: "garbage bytes", change: f => { f.body.signedTransaction = "AAAA"; } },
  { name: "too long base64", change: f => { f.body.signedTransaction = "A".repeat(2501); } },
  { name: "oversized wire", change: f => { f.body.signedTransaction = oversizedSignedBase64(f.payer); } },
  { name: "structure and permit invalid", change: f => { f.body.signedTransaction = toBase64(buildTransaction({ payer: testKeypair(2) })); f.body.permit = "bad"; } },
  { name: "two signers valid permit", change: f => { f.body.signedTransaction = toBase64(buildTransaction({ payer: f.payer, extraSigners: [testKeypair(2)] })); resignPermit(f); } },
  { name: "zero signature valid permit", change: f => { f.body.signedTransaction = toBase64(buildTransaction({ payer: f.payer, signWith: [] })); } },
  { name: "wrong nonzero signature", change: f => { f.tx.signatures[0]![0] = f.tx.signatures[0]![0]! ^ 1; f.body.signedTransaction = toBase64(f.tx); } },
  { name: "message mutation", change: f => { f.body.signedTransaction = toBase64(buildTransaction({ payer: f.payer, paddingBytes: 1 })); } },
  { name: "requested mutation", change: f => { f.body.requested = "1001"; } },
  { name: "liquidity summary mutation", change: f => { f.body.expectedLiquidity = "6"; } },
  { name: "selection mutation", change: f => { f.body.selection = { ...f.body.selection, positionMint: testKeypair(70).publicKey.toBase58() }; } },
  { name: "balances mutation", change: f => { f.body.startingBalances = { ...f.body.startingBalances, a: "11" }; } },
  { name: "zero amount", change: f => { f.body.requested = "0"; resignPermit(f); } },
  { name: "decimal amount", change: f => { f.body.requested = "1.5"; resignPermit(f); } },
  { name: "floor precision", change: f => { f.body.floorBps = 9905; resignPermit(f); } },
  { name: "floor lower endpoint", sends: 1, change: f => { f.body.floorBps = 9500; resignPermit(f); } },
  { name: "floor upper endpoint", sends: 1, change: f => { f.body.floorBps = 10000; resignPermit(f); } },
  { name: "raw bigint beyond safe Number", change: f => { f.body.requested = "9007199254740993"; resignPermit(f); } },
  { name: "raw u64 maximum", change: f => { f.body.requested = "18446744073709551615"; resignPermit(f); } },
  { name: "raw beyond u64 remains simulator bounded", change: f => { f.body.requested = "18446744073709551616"; resignPermit(f); } },
  { name: "expired at entry", change: f => { f.body.expiresAt = NOW; resignPermit(f); } },
  { name: "height expired before sim", change: f => { f.height.mockImplementation(async c => { record("height", f.wallet, c); return 151; }); } },
  { name: "height equal accepted", sends: 1, change: f => { f.height.mockImplementation(async c => { record("height", f.wallet, c); return 150; }); } },
  { name: "expiry after sim skips final height", change: () => { backend.sim.mockImplementationOnce(() => { record("simulator-expiry"); vi.setSystemTime(NOW + 60000); }); } },
  { name: "height expires after sim", change: f => { let n = 0; f.height.mockImplementation(async c => { record("height", f.wallet, c); return ++n === 1 ? 100 : 151; }); } },
  { name: "state read failure", change: () => { backend.state.mockImplementation(async () => { record("state-failure"); throw new Error("Synthetic state unavailable"); }); } },
  { name: "simulation I/O failure", change: f => { f.physical.simulateTransaction.mockImplementation(async () => { record("simulation-failure"); throw new Error("Synthetic simulation unavailable"); }); } },
  { name: "wrong returned signature", sends: 1, change: f => { f.send.mockImplementation(async (bytes, options) => { record("physical-send", f.wallet, Buffer.from(bytes).toString("base64"), options); return "wrong-signature"; }); } },
  { name: "accepted then Beam failure", sends: 1, change: () => { backend.beam.mockImplementation((...args) => { record("beam-failure", ...args); throw new Error("Synthetic metadata unavailable"); }); } },
  { name: "native WSOL and changed state precedence", native: true, change: f => { f.state.wsolBalance = "1"; Object.assign(f.state, { ownsNft: false }); } },
  { name: "native WSOL before simulation", native: true, change: f => { f.state.wsolBalance = "1"; f.before.get(f.inputAta.toBase58())!.data.writeBigUInt64LE(1n, 64); } },
  { name: "NFT missing in additional read", change: f => { f.before.delete(f.nftAta.toBase58()); } },
  ...Object.entries({ ownsNft: false, paused: true, frozen: true, transferFee: true, unsupportedExtensions: ["TransferHook"], sufficientSol: false,
    positionMint: testKeypair(70).publicKey.toBase58(), inputMint: testKeypair(71).publicKey.toBase58(), inputKind: "native", liquidity: "11", rangeSide: "above",
    balances: { input: "999", a: "10", b: "5" } }).map(([key, value]) => ({ name: `state ${key}`, change: (f: Fixture) => { Object.assign(f.state, { [key]: value }); } })),
];
for (const surface of ["app", "http-mcp", "sdk"] as const) describe(surface, () => {
  for (const c of cases) it(c.name, async () => {
    const f = fixture(1, c.native); install(f); c.change?.(f);
    const result = await call(surface, f.body);
    expect({ result, trace }).toMatchSnapshot();
    expect(f.send).toHaveBeenCalledTimes(c.sends ?? 0);
    if (!c.sends) expect(backend.invalidate).not.toHaveBeenCalled();
    for (const [bytes, options] of f.send.mock.calls) {
      expect(Buffer.from(bytes).toString("base64")).toBe(f.body.signedTransaction);
      expect(options).toEqual({ skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3 });
    }
  });
  it("real retry wrapper: timeout then preflight rejection preserves original bytes and unknown envelope", async () => {
    const f = fixture(); const connection = createResilientConnection(f.connection); install(f, connection);
    let attempts = 0;
    f.send.mockImplementation(async (bytes, options) => {
      record("physical-send", f.wallet, Buffer.from(bytes).toString("base64"), options);
      if (++attempts === 1) throw new Error("socket timed out after send");
      throw new Error("Transaction simulation failed: custom program error");
    });
    const original = f.body.signedTransaction, signature = signatureOf(f.tx);
    const result = await call(surface, f.body);
    expect({ result, trace, signature }).toMatchSnapshot();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect(f.send.mock.calls.map(([bytes]) => Buffer.from(bytes).toString("base64"))).toEqual([original, original]);
    expect(f.body.signedTransaction).toBe(original); expect(signatureOf(f.tx)).toBe(signature);
    expect(JSON.stringify(result)).not.toMatch(/sent.*false|safe.to.retry/i);
    expect(backend.invalidate).not.toHaveBeenCalled();
  });
  it("duplicate calls are still separate sends, not new idempotency", async () => {
    const f = fixture(); install(f);
    const first = await call(surface, f.body), second = await call(surface, f.body);
    expect(first).toEqual(second); expect(f.send).toHaveBeenCalledTimes(2); expect(backend.invalidate).toHaveBeenCalledTimes(2);
    expect({ first, trace }).toMatchSnapshot();
  });
  it("concurrent wallets and positions retain isolated transaction facts", async () => {
    const a = fixture(), b = fixture(2);
    backend.rpc.mockReturnValueOnce(a.connection).mockReturnValueOnce(b.connection);
    backend.state.mockImplementation(async (wallet, selection, connection) => {
      const f = wallet === a.wallet ? a : b;
      expect(selection).toEqual(f.facts.selection); expect(connection).toBe(f.connection);
      await Promise.resolve(); return f.state;
    });
    const results = await Promise.all([call(surface, a.body, a.wallet), call(surface, b.body, b.wallet)]);
    for (const [i,f] of [a,b].entries()) {
      expect(JSON.stringify(results[i])).toContain(signatureOf(f.tx)); expect(f.send).toHaveBeenCalledOnce();
      expect(f.send.mock.calls[0]![0]).toEqual(f.tx.serialize());
      expect(backend.invalidate).toHaveBeenCalledWith(f.state.positionMint);
    }
  });
});
it("HTTP MCP schema still precedes token binding, which precedes handler", async () => {
  const f = fixture(); install(f);
  const tokenWallet = testKeypair(2).publicKey.toBase58();
  const invalid = await call("http-mcp", { ...f.body, floorBps: 1 }, tokenWallet);
  const mismatch = await call("http-mcp", f.body, tokenWallet);
  expect({ invalid, mismatch, trace }).toMatchSnapshot(); expect(backend.rpc).not.toHaveBeenCalled();
});
it("HTTP abort during fresh read does not introduce a prepare deadline or discard async context", async () => {
  const f = fixture(); install(f); const controller = new AbortController();
  backend.state.mockImplementation(async () => { record("state-abort"); controller.abort(); await Promise.resolve(); return f.state; });
  const result = await context.run("request-context", () => call("app", f.body, f.wallet, controller.signal));
  expect(JSON.stringify(result)).toContain(signatureOf(f.tx)); expect(f.send).toHaveBeenCalledOnce();
  expect(contexts.every(value => value === "request-context")).toBe(true);
  expect({ result, trace }).toMatchSnapshot();
});
