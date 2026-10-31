// POST /api/tx-landed: read-only, permit-bound, rate limited; RPC trouble is a plain 502 the client keeps polling through.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async (original) => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: () => "test-signing-secret-not-a-real-key",
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { sendPermitFor } from "@/lib/tx-send/permit";
import { resetTxSendRateLimit, TX_LANDED_REQUESTS_PER_IP_PER_MINUTE } from "@/lib/tx-send/rate-limit";
import { POST } from "./route";

const payer = testKeypair(71);
const prepared = buildTransaction({ payer, signWith: [] });
const permit = sendPermitFor(payer.publicKey.toBase58(), toBase64(prepared), SIGNING_SECRET);
const SIG = bs58.encode(new Uint8Array(64).fill(6));
const body = (extra: Record<string, unknown> = {}) =>
  ({ unsignedTransaction: toBase64(prepared), sendPermit: permit, lastValidBlockHeight: 500, preparedAt: Date.now(), ...extra });
async function call(payload: unknown, ip = "203.0.113.9") {
  const response = await POST(new Request("http://localhost/api/tx-landed", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(payload) }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
const connection = {
  getBlockHeight: vi.fn(async () => 1_000),
  getSignaturesForAddress: vi.fn(async () => [{ signature: SIG, blockTime: Math.floor(Date.now() / 1000), slot: 1, err: null, memo: null }]),
  getTransaction: vi.fn(async () => ({ transaction: { message: prepared.message }, meta: { err: null, loadedAddresses: null } })),
  sendRawTransaction: vi.fn(),
};
beforeEach(() => {
  resetTxSendRateLimit();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("POST /api/tx-landed", () => {
  it("finds the prepared transaction and never sends anything", async () => {
    expect(await call(body())).toEqual({ status: 200, json: { status: "landed", signature: SIG } });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("only checks transactions this app prepared (send permit required)", async () => {
    for (const payload of [body({ sendPermit: undefined }), body({ sendPermit: "x".repeat(64) }),
      body({ unsignedTransaction: toBase64(buildTransaction({ payer: testKeypair(72), signWith: [] })) })]) {
      const { status, json } = await call(payload);
      expect(status).toBe(400); expect(JSON.stringify(json)).not.toMatch(/secret|permit=/i);
    }
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it("refuses malformed input", async () => {
    for (const payload of [body({ lastValidBlockHeight: -1 }), body({ preparedAt: "now" }), body({ checked: ["not-a-signature"] }),
      body({ checked: Array(201).fill(SIG) }), body({ unsignedTransaction: "A".repeat(3_000) }), null]) {
      expect((await call(payload)).status).toBe(400);
    }
  });
  it("answers RPC trouble with a plain 502, not 'not landed'", async () => {
    connection.getBlockHeight.mockRejectedValueOnce(new Error("fetch failed https://rpc.example/?api-key=hidden"));
    const { status, json } = await call(body());
    expect(status).toBe(502); expect(json).toEqual({ error: "Could not check Solana right now" });
  });
  it("is rate limited per IP", async () => {
    for (let i = 0; i < TX_LANDED_REQUESTS_PER_IP_PER_MINUTE; i++) expect((await call(body(), "198.51.100.4")).status).toBe(200);
    expect((await call(body(), "198.51.100.4")).status).toBe(429);
    expect((await call(body(), "198.51.100.5")).status).toBe(200);
  });
});
