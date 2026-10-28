// Real MCP adapters -> real token verification route -> real HTTP submit handlers.
// Only builders, chain reads/simulation and physical RPC are disposable offline fixtures.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { VersionedTransaction } from "@solana/web3.js";
vi.mock("server-only", () => ({}));
const backend = vi.hoisted(() => ({ selected: vi.fn(), compound: vi.fn(), open: vi.fn(), withdraw: vi.fn(),
  selectedState: vi.fn(), compoundState: vi.fn(), openState: vi.fn(), selectedSim: vi.fn(), compoundSim: vi.fn(), openSim: vi.fn(), withdrawSim: vi.fn(), rpc: vi.fn(), send: vi.fn(), height: vi.fn(), status: vi.fn() }));
vi.mock("@/lib/selected-atomic", () => ({ buildAndSimulateSelectedZap: backend.selected }));
vi.mock("@sofinance/engine/compound-atomic", () => ({ buildAndSimulateCompound: backend.compound }));
vi.mock("@sofinance/engine/open-atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/open-atomic")>()),
  buildAndSimulateOpenPosition: backend.open,
}));
vi.mock("@sofinance/engine/withdraw/build", () => ({ buildWithdraw: backend.withdraw, simulateWithdraw: backend.withdrawSim }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: backend.selectedState }));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: backend.compoundState }));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: backend.openState }));
vi.mock("@/lib/selected-simulation", () => ({ simulateAndVerifySelectedTransaction: backend.selectedSim }));
vi.mock("@sofinance/engine/compound-simulation", () => ({ simulateAndVerifyCompound: backend.compoundSim }));
vi.mock("@sofinance/engine/open-simulation", () => ({ simulateAndVerifyOpenTransaction: backend.openSim }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: backend.rpc }));
import { POST as mcp } from "@/app/api/mcp/route";
import { POST as verify } from "@/app/api/verify-sign-token/route";
import { POST as selectedSubmit } from "@/app/api/selected-broadcast/route";
import { POST as compoundSubmit } from "@/app/api/compound-broadcast/route";
import { POST as openSubmit } from "@/app/api/open-broadcast/route";
import { POST as withdrawSubmit } from "@/app/api/withdraw-broadcast/route";
import { createMcpServer } from "./create-server";
import { generateMcpToken } from "@/lib/mcp-auth";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import { BLOCKHASH, SIGNING_SECRET, buildTransaction, compoundSummaryFixture, openSummaryFixture, jsonRequest, messageBase64, signatureOf, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { VALID_ARGS, wallet } from "./test-support/dispatch-fixtures";
const payer = testKeypair(1), nft = testKeypair(2);
let client: Client, server: ReturnType<typeof createMcpServer>;
let transaction: VersionedTransaction, openTransaction: VersionedTransaction;
beforeEach(async () => {
  vi.resetAllMocks(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(1793100000000);
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET); vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.invalid.example");
  vi.stubEnv("SOFINANCE_RWA_DB_ENABLED", undefined); vi.stubEnv("SOFINANCE_RWA_GATEWAY_URL", undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
  transaction = buildTransaction({ payer, signWith: [] });
  openTransaction = buildTransaction({ payer, extraSigners: [nft], signWith: [nft] });
  const balances = { input: "2000000", a: "10", b: "20" };
  const selected = { simulated: true, quote: { ...VALID_ARGS.prepare_transaction, requested: "1000000", liquidity: "777", floorBps: 9900, rangeSide: "inside" }, startingLiquidity: "1000", startingBalances: balances, expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: BLOCKHASH };
  const compound = compoundSummaryFixture({ wallet, blockhash: BLOCKHASH });
  const open = openSummaryFixture({ wallet, nftMint: nft.publicKey.toBase58(), blockhash: BLOCKHASH });
  const withdraw = { operation: "withdraw", wallet, positionMint: VALID_ARGS.prepare_withdraw.positionMint, stage: "atomic", transactions: 1, expiresAt: Date.now() + 60000, lastValidBlockHeight: 150, blockhash: BLOCKHASH, requiresSecondConfirmation: false };
  backend.selected.mockResolvedValue({ summary: selected, transaction });
  backend.compound.mockResolvedValue({ summary: compound, transaction });
  backend.open.mockResolvedValue({ summary: open, transaction: openTransaction });
  backend.withdraw.mockResolvedValue({ summary: withdraw, unsignedTransaction: toBase64(transaction), permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, message: messageBase64(transaction), summary: withdraw }) });
  backend.selectedState.mockResolvedValue({ ...VALID_ARGS.prepare_transaction, ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true, liquidity: "1000", rangeSide: "inside", balances });
  backend.compoundState.mockResolvedValue(compound.state);
  backend.openState.mockResolvedValue({ ...open, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true, balances: open.startingBalances });
  backend.compoundSim.mockResolvedValue({ rewards: [] });
  backend.rpc.mockReturnValue({ getBlockHeight: backend.height, sendRawTransaction: backend.send, getSignatureStatuses: backend.status });
  backend.height.mockResolvedValue(100); backend.status.mockResolvedValue({ value: [{ confirmationStatus: "confirmed" }] });
  backend.send.mockImplementation(async bytes => signatureOf(VersionedTransaction.deserialize(bytes)));
  server = createMcpServer(); client = new Client({ name: "prepare-roundtrip", version: "1" });
  const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(a); await client.connect(b);
});
afterEach(async () => { await client?.close(); await server?.close(); vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const operations = [
  { name: "prepare_transaction", kind: "add-liquidity", submit: selectedSubmit, sim: backend.selectedSim },
  { name: "prepare_compound_transaction", kind: "compound", submit: compoundSubmit, sim: backend.compoundSim },
  { name: "prepare_open_position", kind: "open-position", submit: openSubmit, sim: backend.openSim },
  { name: "prepare_withdraw", kind: "withdraw", submit: withdrawSubmit, sim: backend.withdrawSim },
] as const;
for (const surface of ["http", "stdio"] as const) for (const c of operations) {
  it(`${surface} ${c.kind} prepare -> verified token -> HTTP submit preserves full authorization and signed bytes`, async () => {
    const params = { name: c.name, arguments: VALID_ARGS[c.name] };
    const result = surface === "stdio" ? await client.request({ method: "tools/call", params }, CallToolResultSchema) : CallToolResultSchema.parse((await (await mcp(new NextRequest("http://localhost/api/mcp", { method: "POST", headers: { Authorization: `Bearer ${generateMcpToken(wallet, SIGNING_SECRET)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params }) }))).json()).result);
    expect(result.isError).toBeUndefined(); const first = result.content[0];
    if (first?.type !== "text") throw new Error("missing text");
    const prepared = JSON.parse(first.text);
    const verified = await verify(jsonRequest("http://localhost/api/verify-sign-token", { token: prepared.signToken }));
    expect(verified.status).toBe(200); const payload = await verified.json();
    expect(payload).toMatchObject({ kind: c.kind, wallet, permit: prepared.permit, unsignedTransaction: prepared.unsignedTransaction });
    expect(payload.submitArgs.permit).toBe(prepared.permit);
    if (prepared.submitArgs) expect(payload.submitArgs).toEqual(prepared.submitArgs);
    if (c.kind !== "add-liquidity") expect(payload.submitArgs.summary).toEqual(prepared.summary);
    expect(payload.expiresAt).toBe(Date.now() + 60000);
    const tx = VersionedTransaction.deserialize(Buffer.from(payload.unsignedTransaction, "base64"));
    const originalMessage = messageBase64(tx); const partial = tx.signatures[1]?.slice(); tx.sign([payer]);
    expect(messageBase64(tx)).toBe(originalMessage);
    if (c.kind === "open-position") { expect(partial).toEqual(openTransaction.signatures[1]); expect(tx.signatures[1]).toEqual(partial); }
    const response = await c.submit(jsonRequest("http://localhost/api/submit", { ...payload.submitArgs, signedTransaction: toBase64(tx) }));
    const body = await response.json(); expect({ status: response.status, body }).toMatchSnapshot();
    expect(response.status).toBe(200); expect(body.signature).toBe(signatureOf(tx));
    expect(backend.send).toHaveBeenCalledOnce(); expect(backend.send.mock.calls[0]?.[0]).toEqual(tx.serialize());
    expect(c.sim).toHaveBeenCalledOnce(); expect(c.sim.mock.invocationCallOrder[0]!).toBeLessThan(backend.send.mock.invocationCallOrder[0]!);
    if (c.kind === "withdraw") expect(c.sim.mock.calls[0]?.[3]).toBe(true);
    else expect(c.sim.mock.calls[0]?.[0].sigVerify).toBe(true);
    backend.send.mockClear();
    for (const change of [{ permit: "forged" }, { wallet: testKeypair(99).publicKey.toBase58() }]) {
      const rejected = await c.submit(jsonRequest("http://localhost/api/submit", { ...payload.submitArgs, signedTransaction: toBase64(tx), ...change }));
      expect(rejected.status).not.toBe(200); expect(backend.send).not.toHaveBeenCalled();
    }
    for (const token of [`A${prepared.signToken}`, prepared.signToken]) {
      if (token === prepared.signToken) vi.setSystemTime(payload.expiresAt + 1);
      expect((await verify(jsonRequest("http://localhost/api/verify-sign-token", { token }))).status).not.toBe(200);
      expect(backend.send).not.toHaveBeenCalled();
    }
  });
}
