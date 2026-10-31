// POST /api/tx-send: the pipeline's one-shot relay. No resend loop, no expiry gate.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));

import { rpcConnection } from "@sofinance/engine/rpc";
import { buildTransaction, fakeConnection, jsonRequest, oversizedSignedBase64, signatureOf, testKeypair, toBase64, type FakeConnection } from "@/lib/test-support/send-fixtures";
import { POST } from "./route";

const payer = testKeypair(21);
const mint = testKeypair(22);
async function call(body: unknown) {
  const response = await POST(jsonRequest("http://localhost/api/tx-send", body));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
let connection: FakeConnection;
beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  connection = fakeConnection();
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe("POST /api/tx-send", () => {
  it("sends fully signed bytes once with preflight and returns the signature", async () => {
    const tx = buildTransaction({ payer, extraSigners: [mint] });
    connection.sendRawTransaction.mockResolvedValue(signatureOf(tx));
    const { status, json } = await call({ signedTransaction: toBase64(tx) });
    expect(status).toBe(200); expect(json).toEqual({ signature: signatureOf(tx) });
    expect(connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(connection.sendRawTransaction.mock.calls[0]![1]).toMatchObject({ skipPreflight: false, maxRetries: 3 });
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });
  it.each([
    ["missing body", {}],
    ["not base64 tx", { signedTransaction: "AAAA" }],
    ["unsigned", { signedTransaction: toBase64(buildTransaction({ payer, signWith: [] })) }],
    ["missing cosigner", { signedTransaction: toBase64(buildTransaction({ payer, extraSigners: [mint], signWith: [payer] })) }],
    ["oversized", { signedTransaction: oversizedSignedBase64(payer) }],
  ])("refuses %s as not sent without touching RPC", async (_name, body) => {
    const { status, json } = await call(body);
    expect(status).toBe(400); expect(json.sent).toBe(false);
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("refuses a forged signature", async () => {
    const tx = buildTransaction({ payer });
    tx.signatures[0] = new Uint8Array(64).fill(5);
    const { json } = await call({ signedTransaction: toBase64(tx) });
    expect(json.sent).toBe(false); expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("marks a preflight refusal as not sent", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("Transaction simulation failed: Blockhash not found"));
    const { status, json } = await call({ signedTransaction: toBase64(buildTransaction({ payer })) });
    expect(status).toBe(400); expect(json.sent).toBe(false);
  });
  it("does not claim not-sent for an RPC failure that may have reached the network", async () => {
    connection.sendRawTransaction.mockRejectedValue(new Error("socket hang up"));
    const { json } = await call({ signedTransaction: toBase64(buildTransaction({ payer })) });
    expect(json.sent).toBeUndefined();
  });
  it("does not trust an RPC that returns a different signature", async () => {
    connection.sendRawTransaction.mockResolvedValue(bs58.encode(new Uint8Array(64).fill(8)));
    const { status, json } = await call({ signedTransaction: toBase64(buildTransaction({ payer })) });
    expect(status).toBe(400); expect(json.sent).toBeUndefined();
  });
});
