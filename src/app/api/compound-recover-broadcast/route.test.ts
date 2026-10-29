// Characterization tests for POST /api/compound-recover-broadcast: the recovery broadcast tail is
// a hand copy of the send pipeline (it does not use lib/compound-send.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/compound-recovery", () => ({ simulateAndVerifyRecovery: vi.fn() }));

import { issueCompoundPermit } from "@/lib/compound-permit";
import { simulateAndVerifyRecovery } from "@sofinance/engine/compound-recovery";
import { rpcConnection } from "@sofinance/engine/rpc";
import {
  BLOCKHASH, SIGNING_SECRET, buildTransaction, compoundSummaryFixture, fakeConnection, type FakeConnection, jsonRequest, messageBase64, signatureOf,
  testKeypair, toBase64,
} from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const walletKey = testKeypair(1);
const wallet = walletKey.publicKey.toBase58();
const transaction = buildTransaction({ payer: walletKey });
const summary = { ...compoundSummaryFixture({ wallet, blockhash: BLOCKHASH, operation: "recovery" }), wallet };

function body(overrides: Record<string, unknown> = {}, sum: unknown = summary) {
  return {
    signedTransaction: toBase64(transaction), wallet, summary: sum,
    permit: issueCompoundPermit(SIGNING_SECRET, { wallet, summary: sum, message: messageBase64(transaction) }), ...overrides,
  };
}
async function call(payload: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/compound-recover-broadcast", payload));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(simulateAndVerifyRecovery).mockResolvedValue(undefined as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/compound-recover-broadcast", () => {
  it("simulates with sigVerify then broadcasts with the fixed options and returns { signature }", async () => {
    const { response, json } = await call(body());
    expect(response.status).toBe(200);
    expect(json).toEqual({ signature: signatureOf(transaction) });
    expect(simulateAndVerifyRecovery).toHaveBeenCalledWith(expect.objectContaining({ connection, sigVerify: true }));
    expect(connection.sendRawTransaction).toHaveBeenCalledWith(expect.any(Uint8Array), {
      skipPreflight: false, preflightCommitment: "confirmed", maxRetries: 3,
    });
  });

  it("QUIRK: a compound-operation approval cannot be replayed here (operation must be 'recovery'), sent:false", async () => {
    const compound = compoundSummaryFixture({ wallet, blockhash: BLOCKHASH });
    const { json } = await call(body({}, compound));
    expect(json).toEqual({ error: "Compound authorization type, wallet, or expiry mismatch", sent: false });
  });

  it("rejects when the chain already passed lastValidBlockHeight (sent:false)", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const { json } = await call(body());
    expect(json).toEqual({ error: "Recovery authorization wallet or blockhash mismatch", sent: false });
    expect(simulateAndVerifyRecovery).not.toHaveBeenCalled();
  });

  it("a simulation failure is sent:false because nothing was submitted yet", async () => {
    vi.mocked(simulateAndVerifyRecovery).mockRejectedValue(new Error("Recovery simulation failed"));
    const { json } = await call(body());
    expect(json).toEqual({ error: "Recovery simulation failed", sent: false });
  });

  it("signature mismatch after submit: no sent flag", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const { json } = await call(body());
    expect(json).toEqual({ error: "RPC returned recovery signature mismatch, please verify on-chain status" });
  });

  it.each(["socket hang up", "429 Too many requests", "Fetch is aborted", "Transaction simulation failed: Blockhash not found"])("preserves submission uncertainty after send starts: %s", async message => {
    connection.sendRawTransaction.mockRejectedValue(new Error(message));
    expect((await call(body())).json).not.toHaveProperty("sent");
  });

  it("returns only the signature on the recovery path", async () => {
    const { json } = await call(body());
    expect(Object.keys(json)).toEqual(["signature"]);
  });
});
