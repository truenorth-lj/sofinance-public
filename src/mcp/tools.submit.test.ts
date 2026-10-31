// Characterization tests for the three MCP submit tools (the money-moving half of mcp/tools.ts):
//   submitSignedTransaction (add liquidity, a THIRD copy of the broadcast pipeline),
//   submitCompoundTransaction, submitOpenPosition.
// Unlike tools.test.ts these use the REAL permit/HMAC code and real signed transactions; only RPC,
// chain-state readers and simulation are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/selected-state", () => ({ readSelectedPositionState: vi.fn() }));
vi.mock("../lib/selected-simulation", () => ({ simulateAndVerifySelectedTransaction: vi.fn() }));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("@sofinance/engine/open-simulation", () => ({ simulateAndVerifyOpenTransaction: vi.fn() }));
vi.mock("@sofinance/engine/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
vi.mock("@sofinance/engine/compound-simulation", () => ({ simulateAndVerifyCompound: vi.fn() }));

import { issueCompoundPermit } from "../lib/compound-permit";
import { simulateAndVerifyCompound } from "@sofinance/engine/compound-simulation";
import { readCompoundPositionState } from "@sofinance/engine/compound-state";
import { issueOpenPositionPermit } from "../lib/open-permit";
import { simulateAndVerifyOpenTransaction } from "@sofinance/engine/open-simulation";
import { readOpenPoolState } from "@sofinance/engine/open-state";
import { rpcConnection } from "@sofinance/engine/rpc";
import { issueSelectedPermit, type SelectedPermitInput } from "../lib/selected-permit";
import { simulateAndVerifySelectedTransaction } from "../lib/selected-simulation";
import { readSelectedPositionState } from "@sofinance/engine/selected-state";
import {
  BLOCKHASH, SIGNING_SECRET, buildTransaction, compoundSummaryFixture, fakeConnection, type FakeConnection, messageBase64,
  openSummaryFixture, phantomRewriteTransaction, signatureOf, tamperTransferLamports, testKeypair, toBase64,
} from "../lib/test-support/send-fixtures";
import type { SubmitSignedTransactionInput } from "./schemas";
import { submitCompoundTransaction, submitOpenPosition, submitSignedTransaction } from "./tools";

const walletKey = testKeypair(1);
const nftKey = testKeypair(2);
const wallet = walletKey.publicKey.toBase58();
const positionMint = testKeypair(3).publicKey.toBase58();
const inputMint = "So11111111111111111111111111111111111111112";
const selection = { positionMint, inputMint, inputKind: "native" as const };
const startingBalances = { input: "5000000000", a: "10", b: "20" };

let connection: FakeConnection;
let transaction: ReturnType<typeof buildTransaction>;

beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  transaction = buildTransaction({ payer: walletKey });
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

// ---------------------------------------------------------------- submitSignedTransaction
function selectedState(overrides: Record<string, unknown> = {}) {
  return {
    ownsNft: true, paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
    positionMint, inputMint, inputKind: "native", liquidity: "1000", rangeSide: "inside", balances: { ...startingBalances }, ...overrides,
  };
}

function selectedInput(tx = transaction, overrides: Partial<SubmitSignedTransactionInput> = {}): SubmitSignedTransactionInput {
  const fields = {
    wallet, selection, requested: "1000000", floorBps: 9900, expiresAt: Date.now() + 60_000, lastValidBlockHeight: 150,
    startingLiquidity: "1000", expectedLiquidity: "500", rangeSide: "inside" as const, startingBalances, ...overrides,
  };
  const permitInput: SelectedPermitInput = {
    message: messageBase64(tx), wallet: fields.wallet, selection: fields.selection, requested: fields.requested, floorBps: fields.floorBps,
    expiresAt: fields.expiresAt, lastValidBlockHeight: fields.lastValidBlockHeight, startingLiquidity: fields.startingLiquidity,
    expectedLiquidity: fields.expectedLiquidity, rangeSide: fields.rangeSide, startingBalances: fields.startingBalances,
  };
  return { ...fields, signedTransaction: toBase64(tx), permit: issueSelectedPermit(SIGNING_SECRET, permitInput), ...overrides };
}

describe("submitSignedTransaction (MCP add-liquidity submit)", () => {
  beforeEach(() => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(selectedState() as never);
    vi.mocked(simulateAndVerifySelectedTransaction).mockResolvedValue(undefined as never);
  });

  it("verifies, simulates with sigVerify and broadcasts with the same fixed options as the web route", async () => {
    const result = await submitSignedTransaction(selectedInput());
    expect(result).toEqual({ signature: signatureOf(transaction) });
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
    expect(readSelectedPositionState).toHaveBeenCalledWith(wallet, selection, connection);
    expect(simulateAndVerifySelectedTransaction).toHaveBeenCalledWith(expect.objectContaining({
      connection, requested: 1_000_000n, expectedLiquidity: 500n, sigVerify: true,
    }));
    expect(vi.mocked(simulateAndVerifySelectedTransaction).mock.invocationCallOrder[0]!)
      .toBeLessThan(connection.sendRawTransaction.mock.invocationCallOrder[0]!);
  });

  it.each<[string, Partial<SubmitSignedTransactionInput>]>([
    ["requested is zero", { requested: "0" }],
    ["expectedLiquidity is zero", { expectedLiquidity: "0" }],
    ["expiresAt already passed", { expiresAt: Date.now() - 1 }],
  ])("rejects when %s", async (_name, overrides) => {
    await expect(submitSignedTransaction(selectedInput(transaction, overrides))).rejects.toThrow("Invalid or expired signed transaction input");
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("QUIRK: the tool function itself does not re-validate floorBps (zod in the MCP layer does); a permitted 9000 passes", async () => {
    await expect(submitSignedTransaction(selectedInput(transaction, { floorBps: 9000 }))).resolves.toMatchObject({ signature: signatureOf(transaction) });
  });

  it("QUIRK: a non-numeric 'requested' surfaces BigInt's raw SyntaxError text", async () => {
    await expect(submitSignedTransaction(selectedInput(transaction, { requested: "abc" }))).rejects.toThrow(/Cannot convert abc to a BigInt/);
  });

  it("QUIRK: the permit is verified BEFORE the structural checks (the web route does it the other way round)", async () => {
    const wrongPayer = buildTransaction({ payer: testKeypair(9) });
    const badPermit = { ...selectedInput(wrongPayer), permit: "0".repeat(64) };
    await expect(submitSignedTransaction(badPermit)).rejects.toThrow("Transaction content does not match server's simulation permit");
    await expect(submitSignedTransaction(selectedInput(wrongPayer))).rejects.toThrow("Payer, signature count, or transaction size mismatch");
  });

  it("rejects unsigned and two-signer transactions", async () => {
    for (const tx of [buildTransaction({ payer: walletKey, signWith: [] }), buildTransaction({ payer: walletKey, extraSigners: [nftKey] })]) {
      await expect(submitSignedTransaction(selectedInput(tx))).rejects.toThrow("Payer, signature count, or transaction size mismatch");
    }
  });

  it("QUIRK: a header/signature-array mismatch is rejected by web3.js itself (the explicit signatures.length check is redundant)", async () => {
    const extra = buildTransaction({ payer: walletKey });
    extra.signatures.push(new Uint8Array(64).fill(1));
    await expect(submitSignedTransaction(selectedInput(extra))).rejects.toThrow("Expected signatures length to be equal to the number of required signatures");
  });

  it("rejects a permit changed after issue and a permit from another key; missing key throws a signing-key error", async () => {
    const input = selectedInput();
    await expect(submitSignedTransaction({ ...input, requested: "1000001" })).rejects.toThrow("does not match server's simulation permit");
    vi.stubEnv("JUPITER_API_KEY", "rotated-key");
    await expect(submitSignedTransaction(input)).rejects.toThrow("does not match server's simulation permit");
    vi.stubEnv("JUPITER_API_KEY", undefined);
    await expect(submitSignedTransaction(input)).rejects.toThrow("Missing server signing key");
  });

  it("rejects an expired blockhash window; height === lastValid is still accepted", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow("Transaction blockhash expired");
    connection.getBlockHeight.mockResolvedValue(150);
    await expect(submitSignedTransaction(selectedInput())).resolves.toBeTruthy();
  });

  it.each<[string, Record<string, unknown>]>([
    ["NFT not owned", { ownsNft: false }], ["paused", { paused: true }], ["frozen", { frozen: true }],
    ["transfer fee", { transferFee: true }], ["unsupported extensions", { unsupportedExtensions: ["X"] }],
    ["insufficient SOL", { sufficientSol: false }], ["position mint differs", { positionMint: testKeypair(60).publicKey.toBase58() }],
    ["input mint differs", { inputMint: testKeypair(61).publicKey.toBase58() }], ["input kind differs", { inputKind: "token" }],
    ["liquidity differs", { liquidity: "1" }], ["range side differs", { rangeSide: "below" }],
    ["input balance differs", { balances: { ...startingBalances, input: "1" } }],
    ["balance A differs", { balances: { ...startingBalances, a: "1" } }], ["balance B differs", { balances: { ...startingBalances, b: "1" } }],
  ])("rejects when state changed: %s (QUIRK: different wording from the route)", async (_name, override) => {
    vi.mocked(readSelectedPositionState).mockResolvedValue(selectedState(override) as never);
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow("Position, liquidity, or wallet balance has changed since preparation");
    expect(simulateAndVerifySelectedTransaction).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("simulation failure aborts before broadcast", async () => {
    vi.mocked(simulateAndVerifySelectedTransaction).mockRejectedValue(new Error("simulation failed"));
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow("simulation failed");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("rejects when expiry passes during simulation, and when the chain passes lastValid during simulation", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-11T00:00:00Z"));
    const input = selectedInput(transaction, { expiresAt: Date.now() + 1_000 });
    vi.mocked(simulateAndVerifySelectedTransaction).mockImplementation((async () => { vi.setSystemTime(Date.now() + 2_000); }) as never);
    await expect(submitSignedTransaction(input)).rejects.toThrow("Signed transaction expired before broadcast");
    vi.useRealTimers();
    vi.mocked(simulateAndVerifySelectedTransaction).mockResolvedValue(undefined as never);
    connection.getBlockHeight.mockResolvedValueOnce(100).mockResolvedValueOnce(151);
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow("Signed transaction expired before broadcast");
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("signature mismatch (QUIRK: wording lacks 'Dedicated')", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow(/^RPC returned transaction signature mismatch$/);
  });

  it("QUIRK: the tool function itself does not sanitize (compound/open submit do); redaction happens at the MCP boundary (route.ts / server.ts catch, see api/mcp/route.test.ts)", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("failed https://rpc.example/x?api-key=SECRET123"));
    await expect(submitSignedTransaction(selectedInput())).rejects.toThrow("https://rpc.example/x?api-key=SECRET123");
  });

  it("returns only the signature after the single send", async () => {
    await expect(submitSignedTransaction(selectedInput())).resolves.toEqual({
      signature: signatureOf(transaction),
    });
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------- submitCompoundTransaction
describe("submitCompoundTransaction (MCP compound submit)", () => {
  const summary = compoundSummaryFixture({ wallet, blockhash: BLOCKHASH });
  const input = (tx = transaction, sum: unknown = summary, overrides: Record<string, unknown> = {}) => ({
    signedTransaction: toBase64(tx), wallet, summary: sum,
    permit: issueCompoundPermit(SIGNING_SECRET, { wallet, summary: sum, message: messageBase64(tx) }), ...overrides,
  });
  beforeEach(() => {
    vi.mocked(readCompoundPositionState).mockResolvedValue({ ...summary.state } as never);
    vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [] } as never);
  });

  it("delegates to sendSignedCompoundTransaction and returns the signature", async () => {
    await expect(submitCompoundTransaction(input())).resolves.toEqual({
      signature: signatureOf(transaction),
    });
  });

  it("pre-broadcast failures get the 'not sent, safe to retry' suffix", async () => {
    await expect(submitCompoundTransaction(input(transaction, summary, { permit: "0".repeat(64) })))
      .rejects.toThrow("Transaction does not match simulated compound authorization Transaction was not sent, safe to retry.");
    await expect(submitCompoundTransaction(input(buildTransaction({ payer: testKeypair(9) }))))
      .rejects.toThrow("Compound payer, signature, or transaction size mismatch Transaction was not sent, safe to retry.");
    await expect(submitCompoundTransaction(input(transaction, { ...summary, operation: "recovery" })))
      .rejects.toThrow("Compound authorization type, wallet, or expiry mismatch Transaction was not sent, safe to retry.");
  });

  it("a state-changed CompoundSendError(sent:false) is sanitized and carries the retry hint", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    await expect(submitCompoundTransaction(input())).rejects.toThrow(/expired before Solana included it.*safe to retry/);
  });

  it("an unknown-sent failure (signature mismatch) has NO retry hint and is sanitized", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const error = await submitCompoundTransaction(input()).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).toBe("RPC returned compound signature mismatch, please verify on-chain status");
  });

  it("redacts a URL in a send error", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("boom https://rpc.example/?api-key=SECRET123"));
    const error = await submitCompoundTransaction(input()).then(() => null, (caught: unknown) => caught as Error);
    expect(error?.message).not.toContain("SECRET123");
    expect(error?.message).not.toContain("rpc.example");
  });
});

// ---------------------------------------------------------------- submitOpenPosition
describe("submitOpenPosition (MCP open-position submit)", () => {
  const summary = openSummaryFixture({ wallet, nftMint: nftKey.publicKey.toBase58(), blockhash: BLOCKHASH });
  const openTx = () => buildTransaction({ payer: walletKey, extraSigners: [nftKey] });
  const input = (tx = openTx(), sum: unknown = summary, overrides: Record<string, unknown> = {}) => ({
    signedTransaction: toBase64(tx), wallet, summary: sum,
    permit: issueOpenPositionPermit(SIGNING_SECRET, { wallet, summary: sum, message: messageBase64(tx) }), ...overrides,
  });
  beforeEach(() => {
    transaction = openTx();
    connection.sendRawTransaction.mockImplementation(async () => signatureOf(transaction));
    vi.mocked(readOpenPoolState).mockResolvedValue({
      paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
      poolId: summary.poolId, inputMint: summary.inputMint, inputKind: summary.inputKind, balances: { ...summary.startingBalances },
    } as never);
    vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue(undefined as never);
  });

  it("returns the open-send result on success", async () => {
    await expect(submitOpenPosition(input(transaction))).resolves.toMatchObject({
      signature: signatureOf(transaction), positionMint: nftKey.publicKey.toBase58(), positionAccount: summary.positionAccount,
    });
  });

  it("a bad permit (plain Error from the lib) is wrapped with the retry hint", async () => {
    await expect(submitOpenPosition(input(transaction, summary, { permit: "0".repeat(64) })))
      .rejects.toThrow("Transaction does not match simulated open-position authorization Transaction was not sent, safe to retry.");
  });

  it("keeps a signature mismatch after send unknown without a retry hint", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const error = await submitOpenPosition(input(transaction)).catch((caught: unknown) => caught as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("RPC returned transaction signature mismatch");
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
  });

  it("accepts a Phantom-style rewrite when unsignedTransaction is provided", async () => {
    const unsigned = buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [] });
    const rewritten = phantomRewriteTransaction(unsigned);
    rewritten.sign([walletKey, nftKey]);
    connection.sendRawTransaction.mockImplementation(async () => signatureOf(rewritten));
    const rewrittenSummary = openSummaryFixture({
      wallet, nftMint: nftKey.publicKey.toBase58(), blockhash: rewritten.message.recentBlockhash,
    });
    await expect(submitOpenPosition({
      signedTransaction: toBase64(rewritten),
      unsignedTransaction: toBase64(unsigned),
      wallet, summary: rewrittenSummary,
      permit: issueOpenPositionPermit(SIGNING_SECRET, {
        wallet, summary: rewrittenSummary, message: messageBase64(unsigned),
      }),
    })).resolves.toMatchObject({ signature: signatureOf(rewritten), positionMint: nftKey.publicKey.toBase58() });
  });

  it("rejects a tampered amount even when the permit matches the prepared message", async () => {
    const unsigned = buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [] });
    const tampered = tamperTransferLamports(unsigned, 99);
    tampered.sign([walletKey, nftKey]);
    const tamperedSummary = openSummaryFixture({
      wallet, nftMint: nftKey.publicKey.toBase58(), blockhash: unsigned.message.recentBlockhash,
    });
    await expect(submitOpenPosition({
      signedTransaction: toBase64(tampered),
      unsignedTransaction: toBase64(unsigned),
      wallet, summary: tamperedSummary,
      permit: issueOpenPositionPermit(SIGNING_SECRET, {
        wallet, summary: tamperedSummary, message: messageBase64(unsigned),
      }),
    })).rejects.toThrow(/required instruction/);
    expect(rpcConnection).not.toHaveBeenCalled();
  });
});

// Exercise actual public entrypoints and real handlers/permits, mocking only backend I/O.
// These assertions were run against the switches before introducing dispatch.ts.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/mcp/route";
import { generateMcpToken } from "@/lib/mcp-auth";
import { createMcpServer } from "./create-server";
import { withdrawPermit } from "@sofinance/engine/withdraw/permit";
import { simulateWithdraw } from "@sofinance/engine/withdraw/build";
vi.mock("@sofinance/engine/withdraw/build", () => ({ simulateWithdraw: vi.fn() }));

for (const surface of ["http", "stdio"] as const) describe(`${surface} real submit pipelines`, () => {
  async function call(name: string, args: unknown) {
    if (surface === "http") {
      const response = await POST(new NextRequest("http://localhost/api/mcp", {
        method: "POST", headers: { Authorization: `Bearer ${generateMcpToken(wallet, SIGNING_SECRET)}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      }));
      expect(response.status).toBe(200);
      return CallToolResultSchema.parse((await response.json()).result);
    }
    const server = createMcpServer(), client = new Client({ name: "real-submit", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      return await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
    } finally { await client.close(); await server.close(); }
  }
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readSelectedPositionState).mockResolvedValue(selectedState() as never);
    vi.mocked(simulateAndVerifySelectedTransaction).mockResolvedValue(undefined as never);
    vi.mocked(simulateWithdraw).mockResolvedValue(undefined as never);
    connection.getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed" }] });
  });
  afterEach(() => { vi.restoreAllMocks(); });
  function input(name: string) {
    if (name === "submit_signed_transaction") return selectedInput();
    if (name === "submit_compound_transaction") {
      const summary = compoundSummaryFixture({ wallet, blockhash: BLOCKHASH });
      vi.mocked(readCompoundPositionState).mockResolvedValue({ ...summary.state } as never);
      vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [] } as never);
      return { wallet, signedTransaction: toBase64(transaction), summary,
        permit: issueCompoundPermit(SIGNING_SECRET, { wallet, summary, message: messageBase64(transaction) }) };
    }
    if (name === "submit_open_position") {
      transaction = buildTransaction({ payer: walletKey, extraSigners: [nftKey] });
      const summary = openSummaryFixture({ wallet, nftMint: nftKey.publicKey.toBase58(), blockhash: BLOCKHASH });
      vi.mocked(readOpenPoolState).mockResolvedValue({ paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
        poolId: summary.poolId, inputMint: summary.inputMint, inputKind: summary.inputKind, balances: { ...summary.startingBalances } } as never);
      vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue(undefined as never);
      return { wallet, signedTransaction: toBase64(transaction), summary,
        permit: issueOpenPositionPermit(SIGNING_SECRET, { wallet, summary, message: messageBase64(transaction) }) };
    }
    const summary = { operation: "withdraw", wallet, stage: "atomic", expiresAt: Date.now() + 60_000,
      lastValidBlockHeight: 150, blockhash: BLOCKHASH, requiresSecondConfirmation: false };
    return { wallet, signedTransaction: toBase64(transaction), summary,
      permit: withdrawPermit.issue(SIGNING_SECRET, { wallet, summary, message: messageBase64(transaction) }) };
  }
  const submissions = ["submit_signed_transaction", "submit_compound_transaction", "submit_open_position", "submit_withdraw"];
  it.each(submissions)("%s preserves exact bytes, one send and simulation-before-send", async name => {
    const args = input(name);
    const result = await call(name, args);
    expect(result.isError).toBeUndefined();
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining(signatureOf(transaction)) }]);
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(Buffer.from(connection.sendRawTransaction.mock.calls[0]![0] as Uint8Array)).toEqual(Buffer.from(transaction.serialize()));
    const simulations = [simulateAndVerifySelectedTransaction, simulateAndVerifyCompound, simulateAndVerifyOpenTransaction, simulateWithdraw];
    const simulation = simulations[submissions.indexOf(name)]!;
    expect(simulation).toHaveBeenCalledOnce();
    expect(vi.mocked(simulation).mock.invocationCallOrder[0]).toBeLessThan(connection.sendRawTransaction.mock.invocationCallOrder[0]!);
    expect(connection.getBlockHeight).toHaveBeenCalledTimes(2);
  });
  it.each(submissions)("%s refuses forged permit before backend I/O", async name => {
    const result = await call(name, { ...input(name), permit: "forged" });
    expect(result.isError).toBe(true);
    expect(rpcConnection).not.toHaveBeenCalled();
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it.each(submissions)("%s never turns unknown send into safe-to-retry or definitely-unsent", async name => {
    const args = input(name);
    connection.sendRawTransaction.mockRejectedValue(new Error("socket hang up https://rpc.invalid/?api-key=SECRET"));
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toMatch(/safe to retry|not sent|SECRET|sent.*false/);
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(Buffer.from(connection.sendRawTransaction.mock.calls[0]![0] as Uint8Array)).toEqual(Buffer.from(transaction.serialize()));
  });
  it.each(submissions)("%s keeps timeout then retry-preflight failure unknown using the real engine wrapper", async name => {
    const { createResilientConnection } = await import("@sofinance/engine/rpc/connection");
    const { SendTransactionError } = await import("@solana/web3.js");
    const args = input(name);
    const originalSignature = signatureOf(transaction);
    connection.sendRawTransaction.mockRejectedValueOnce(new Error("request timed out after remote acceptance"));
    connection.sendRawTransaction.mockRejectedValue(new SendTransactionError({ action: "simulate", signature: "",
      transactionMessage: "Transaction simulation failed: insufficient funds" }));
    vi.mocked(rpcConnection).mockReturnValue(createResilientConnection(connection as never, null, {
      primaryId: "default", fallbackId: "default", retry: { maxAttempts: 2, baseMs: 0, maxDelayMs: 0, budgetMs: 2000 },
    }));
    const result = await call(name, args);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/safe to retry|not sent|sent.*false/);
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(2);
    for (const [bytes] of connection.sendRawTransaction.mock.calls) {
      expect(Buffer.from(bytes as Uint8Array)).toEqual(Buffer.from(transaction.serialize()));
    }
    expect(signatureOf(transaction)).toBe(originalSignature);
  });
  it("withdraw's record summary remains accepted by the parser, then permit fails before backend", async () => {
    const result = await call("submit_withdraw", { wallet, summary: {}, permit: "forged", signedTransaction: toBase64(transaction) });
    expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ error: "Withdrawal authorization does not match transaction" }, null, 2) }]);
    expect(rpcConnection).not.toHaveBeenCalled();
  });
});
