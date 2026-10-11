// Characterization tests for POST /api/compound-broadcast, including the shared
// parseCompoundBroadcast() request validator (lib/compound-api.ts).
// Real: parsing, size/payer/permit/summary checks, compound-send. Mocked: RPC, state, simulation, Beam.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@/lib/compound-state", () => ({ readCompoundPositionState: vi.fn() }));
vi.mock("@/lib/compound-simulation", () => ({ simulateAndVerifyCompound: vi.fn() }));
vi.mock("@/lib/solami-beam", () => ({ lookupBeamAfterSend: vi.fn() }));

import { issueCompoundPermit } from "@/lib/compound-permit";
import { simulateAndVerifyCompound } from "@/lib/compound-simulation";
import { readCompoundPositionState } from "@/lib/compound-state";
import { rpcConnection } from "@/lib/rpc";
import { lookupBeamAfterSend } from "@/lib/solami-beam";
import {
  BEAM_RESULT, BLOCKHASH, SIGNING_SECRET, buildTransaction, compoundSummaryFixture, fakeConnection, type FakeConnection, jsonRequest, messageBase64,
  oversizedSignedBase64, signatureOf, testKeypair, toBase64,
} from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const walletKey = testKeypair(1);
const wallet = walletKey.publicKey.toBase58();
const transaction = buildTransaction({ payer: walletKey });
const summary = compoundSummaryFixture({ wallet, blockhash: BLOCKHASH });

function body(overrides: Record<string, unknown> = {}, tx = transaction, sum: unknown = summary) {
  return {
    signedTransaction: toBase64(tx), wallet, summary: sum,
    permit: issueCompoundPermit(SIGNING_SECRET, { wallet, summary: sum, message: messageBase64(tx) }), ...overrides,
  };
}
async function call(payload: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/compound-broadcast", payload));
  return { response, json: await response.json() as Record<string, unknown> };
}

let connection: FakeConnection;
beforeEach(() => {
  vi.stubEnv("JUPITER_API_KEY", SIGNING_SECRET);
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection({ sendRawTransaction: vi.fn(async () => signatureOf(transaction)) });
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
  vi.mocked(readCompoundPositionState).mockResolvedValue({ ...summary.state } as never);
  vi.mocked(simulateAndVerifyCompound).mockResolvedValue({ rewards: [] } as never);
  vi.mocked(lookupBeamAfterSend).mockResolvedValue(BEAM_RESULT as never);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("POST /api/compound-broadcast", () => {
  it("QUIRK: on success returns ONLY { signature } (beam fields from the lib are dropped, unlike selected/open)", async () => {
    const { response, json } = await call(body());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(json).toEqual({ signature: signatureOf(transaction) });
    expect(lookupBeamAfterSend).toHaveBeenCalledOnce();
  });

  it("rejects a request body over 30,000 chars, with sent:false", async () => {
    const { response, json } = await call(JSON.stringify({ ...body(), pad: "x".repeat(30_001) }));
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: "Compound request too large", sent: false });
  });

  it.each<[string, unknown, string]>([
    ["a JSON array body", [], "Invalid compound input"],
    ["a JSON null body", null, "Invalid compound input"],
    ["an invalid wallet", { ...body(), wallet: "bad" }, "Invalid wallet address"],
    ["a non-string signedTransaction", { ...body(), signedTransaction: 1 }, "Invalid signed transaction input"],
    ["a signedTransaction over 2,500 chars", { ...body(), signedTransaction: "A".repeat(2_501) }, "Invalid signed transaction input"],
  ])("rejects %s (sent:false)", async (_name, payload, message) => {
    const { response, json } = await call(payload);
    expect(response.status).toBe(400);
    expect(json).toEqual({ error: message, sent: false });
  });

  it("rejects wrong payer, unsigned and two-signer transactions with the structural message", async () => {
    const structural = "Compound payer, signature, or transaction size mismatch";
    for (const tx of [
      buildTransaction({ payer: testKeypair(3) }),
      buildTransaction({ payer: walletKey, signWith: [] }),
      buildTransaction({ payer: walletKey, extraSigners: [testKeypair(4)] }),
    ]) {
      const { json } = await call(body({}, tx));
      expect(json).toEqual({ error: structural, sent: false });
    }
  });

  it("QUIRK: a header/signature-array mismatch is rejected by web3.js itself (the explicit signatures.length check is redundant)", async () => {
    const extra = buildTransaction({ payer: walletKey });
    extra.signatures.push(new Uint8Array(64).fill(1));
    const { json } = await call(body({}, extra));
    expect(json).toEqual({ error: "Expected signatures length to be equal to the number of required signatures", sent: false });
  });

  it("QUIRK: an oversized raw tx fails with web3.js's RangeError text rather than the size message", async () => {
    const { json } = await call(body({ signedTransaction: oversizedSignedBase64(walletKey) }));
    expect(json).toEqual({ error: "encoding overruns Uint8Array", sent: false });
  });

  it("rejects a permit mismatch (checked after structure, before the summary)", async () => {
    const { json } = await call(body({ permit: "0".repeat(64) }));
    expect(json).toEqual({ error: "Transaction does not match simulated compound authorization", sent: false });
  });

  it("QUIRK: a missing permit is a mismatch error (verify tolerates non-strings), not an input error", async () => {
    const { json } = await call(body({ permit: undefined }));
    expect(json).toEqual({ error: "Transaction does not match simulated compound authorization", sent: false });
  });

  it("QUIRK: a missing summary reaches the permit HMAC (canonical(undefined)) and fails as a permit mismatch", async () => {
    const { json } = await call({ ...body(), summary: undefined });
    expect(json).toEqual({ error: "Transaction does not match simulated compound authorization", sent: false });
  });

  it.each<[string, Record<string, unknown>]>([
    ["wrong operation", { operation: "recovery" }],
    ["expired summary", { expiresAt: Date.now() - 1_000 }],
    ["lastValidBlockHeight not positive", { lastValidBlockHeight: 0 }],
    ["blockhash differing from the tx", { blockhash: "11111111111111111111111111111111" }],
    ["state.wallet differing", { state: { ...summary.state, wallet: testKeypair(5).publicKey.toBase58() } }],
  ])("rejects a validly-permitted summary with %s", async (_name, override) => {
    const bad = { ...summary, ...override };
    const { json } = await call(body({}, transaction, bad));
    expect(json).toEqual({ error: "Compound authorization type, wallet, or expiry mismatch", sent: false });
  });

  it("chain-state failure carries sent:false", async () => {
    connection.getBlockHeight.mockResolvedValue(151);
    const { json } = await call(body());
    // sanitizePublicError prefixes its mapped wording to the original detail.
    expect(json).toEqual({ error: "Transaction blockhash expired. Compound blockhash expired", sent: false });
  });

  it("signature mismatch after broadcast has NO sent flag (unknown)", async () => {
    connection.sendRawTransaction.mockResolvedValue("1".repeat(64));
    const { json } = await call(body());
    expect(json).toEqual({ error: "RPC returned compound signature mismatch, please verify on-chain status" });
  });

  it("preflight failure from the RPC carries sent:false and a mapped public message", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("Transaction simulation failed: custom program error: 0x1781"));
    const { json } = await call(body());
    expect(json).toMatchObject({ sent: false });
    expect(String(json.error)).toContain("Pool price moved past the add-liquidity cap");
  });
});
