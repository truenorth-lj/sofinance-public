// Characterization tests for POST /api/open-broadcast (route layer over submitOpenPositionFromParts).
// Real: route validation, permit, open-send logic, apiError sanitising. Mocked: RPC, state, simulation, Beam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/open-state", () => ({ readOpenPoolState: vi.fn() }));
vi.mock("@sofinance/engine/open-simulation", () => ({ simulateAndVerifyOpenTransaction: vi.fn() }));
vi.mock("@/lib/beam-after-send", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/beam-after-send")>()), beamAfterSend: vi.fn() }));

import { issueOpenPositionPermit } from "@/lib/open-permit";
import { readOpenPoolState } from "@sofinance/engine/open-state";
import { simulateAndVerifyOpenTransaction } from "@sofinance/engine/open-simulation";
import { rpcConnection } from "@sofinance/engine/rpc";
import { beamAfterSend } from "@/lib/beam-after-send";
import {
  BEAM_RESULT, BLOCKHASH, SIGNING_SECRET, buildTransaction, fakeConnection, type FakeConnection, jsonRequest, messageBase64, openSummaryFixture,
  phantomRewriteTransaction, signatureOf, tamperTransferLamports, testKeypair, toBase64,
} from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const walletKey = testKeypair(1);
const nftKey = testKeypair(2);
const wallet = walletKey.publicKey.toBase58();
const nftMint = nftKey.publicKey.toBase58();
const transaction = buildTransaction({ payer: walletKey, extraSigners: [nftKey] });
const summary = openSummaryFixture({ wallet, nftMint, blockhash: BLOCKHASH });

function body(overrides: Record<string, unknown> = {}) {
  return {
    signedTransaction: toBase64(transaction), wallet, summary,
    permit: issueOpenPositionPermit(SIGNING_SECRET, { wallet, summary, message: messageBase64(transaction) }), ...overrides,
  };
}
async function call(payload: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/open-broadcast", payload));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readOpenPoolState).mockResolvedValue({
    paused: false, frozen: false, transferFee: false, unsupportedExtensions: [], sufficientSol: true,
    poolId: summary.poolId, inputMint: summary.inputMint, inputKind: summary.inputKind, balances: { ...summary.startingBalances },
  } as never);
  vi.mocked(simulateAndVerifyOpenTransaction).mockResolvedValue(undefined as never);
  vi.mocked(beamAfterSend).mockResolvedValue(BEAM_RESULT as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/open-broadcast", () => {
  it("broadcasts and returns signature, position ids and beam fields with no-store", async () => {
    const { response, json } = await call(body());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({
      signature: signatureOf(transaction), positionMint: nftMint, positionAccount: summary.positionAccount,
      beam: BEAM_RESULT.beam, beamLabel: "Beam landed", beamLandingUrl: BEAM_RESULT.beamLandingUrl,
    });
  });

  it("rejects an invalid wallet with sent:false", async () => {
    const { response, json } = await call(body({ wallet: "bad" }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid wallet address", sent: false });
  });

  it.each<[string, Record<string, unknown>]>([
    ["signedTransaction not a string", { signedTransaction: 5 }],
    ["signedTransaction longer than 2,500 chars", { signedTransaction: "A".repeat(2_501) }],
    ["permit not a string", { permit: undefined }],
    ["summary missing", { summary: undefined }],
    ["summary not an object", { summary: "x" }],
  ])("rejects %s with sent:false", async (_name, override) => {
    const { response, json } = await call(body(override));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Invalid or expired signed open-position input", sent: false });
  });

  it("a bad permit is reported with sent:false (pre-broadcast)", async () => {
    const { response, json } = await call(body({ permit: "0".repeat(64) }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Transaction does not match simulated open-position authorization", sent: false });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("a state-changed failure is wrapped by open-send and carries sent:false", async () => {
    vi.mocked(readOpenPoolState).mockResolvedValue({ paused: true } as never);
    const { json } = await call(body());
    expect(json).toEqual({ error: "Pool, wallet balance, or asset flags have changed since preparation", sent: false });
  });

  it("does not declare signature mismatch after send safe to retry", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const { json } = await call(body());
    expect(connection.sendRawTransaction).toHaveBeenCalledOnce();
    expect(json).toEqual({ error: "RPC returned transaction signature mismatch" });
  });
  it("leaves a lost send response unknown", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("socket hang up"));
    const { json } = await call(body());
    expect(json).not.toHaveProperty("sent");
  });

  it("accepts a Phantom-style rewrite when unsignedTransaction is the permit-bound prepared message", async () => {
    const unsigned = buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [] });
    const rewritten = phantomRewriteTransaction(unsigned);
    rewritten.sign([walletKey, nftKey]);
    connection.sendRawTransaction.mockImplementation(async () => signatureOf(rewritten));
    const rewrittenSummary = openSummaryFixture({ wallet, nftMint, blockhash: rewritten.message.recentBlockhash });
    const { response, json } = await call({
      signedTransaction: toBase64(rewritten),
      unsignedTransaction: toBase64(unsigned),
      wallet, summary: rewrittenSummary,
      permit: issueOpenPositionPermit(SIGNING_SECRET, {
        wallet, summary: rewrittenSummary, message: messageBase64(unsigned),
      }),
    });
    expect(response.status).toBe(200);
    expect(json).toMatchObject({ signature: signatureOf(rewritten), positionMint: nftMint });
    expect(simulateAndVerifyOpenTransaction).toHaveBeenCalledWith(expect.objectContaining({
      sigVerify: true,
      prepared: expect.objectContaining({ message: expect.anything() }),
    }));
  });

  it("rejects a tampered transfer amount even when the permit matches the prepared message", async () => {
    const unsigned = buildTransaction({ payer: walletKey, extraSigners: [nftKey], signWith: [] });
    const tampered = tamperTransferLamports(unsigned, 99);
    tampered.sign([walletKey, nftKey]);
    const tamperedSummary = openSummaryFixture({ wallet, nftMint, blockhash: unsigned.message.recentBlockhash });
    const { response, json } = await call({
      signedTransaction: toBase64(tampered),
      unsignedTransaction: toBase64(unsigned),
      wallet, summary: tamperedSummary,
      permit: issueOpenPositionPermit(SIGNING_SECRET, {
        wallet, summary: tamperedSummary, message: messageBase64(unsigned),
      }),
    });
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: expect.stringMatching(/required instruction/), sent: false });
    expect(rpcConnection).not.toHaveBeenCalled();
  });

  it("QUIRK: a garbage signedTransaction leaks the raw web3.js deserialize message", async () => {
    const { response, json } = await call(body({ signedTransaction: "AAAA" }));
    expect(response.status).toBe(400);
    expect(json).toMatchObject({ sent: false });
    expect(typeof json.error).toBe("string");
  });
});
