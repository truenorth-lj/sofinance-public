// POST /api/tx-simulate (pre-wallet guard): read-only, bound to the prepare-issued check permit, refused ("expired")
// once lastValidBlockHeight has passed, rate limited per IP, per permit and per wallet, public RPC only.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async (original) => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: () => "test-signing-secret-not-a-real-key",
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { SIM_EXPIRED_CAUSE } from "@/lib/tx-simulate/cause";
import { PERMITTED_TX_MAX_BASE64 } from "@/lib/tx-simulate/permitted-input.server";
import { issueTxLandedPermit, sendPermitFor } from "@/lib/tx-send/permit";
import { resetTxSendRateLimit, TX_SIMULATE_REQUESTS_PER_CHECK_PER_MINUTE, TX_SIMULATE_REQUESTS_PER_IP_PER_MINUTE,
  TX_SIMULATE_REQUESTS_PER_WALLET_PER_MINUTE } from "@/lib/tx-send/rate-limit";
import { POST } from "./route";

const payer = testKeypair(81);
const WALLET = payer.publicKey.toBase58();
const LVBH = 990;
const txFor = (seed = 81) => buildTransaction({ payer: testKeypair(seed), signWith: [] });
const prepared = txFor();
const body = (tx = prepared, extra: Record<string, unknown> = {}) => ({ unsignedTransaction: toBase64(tx),
  landedPermit: issueTxLandedPermit(SIGNING_SECRET, tx.message.staticAccountKeys[0]!.toBase58(), tx.serialize(), LVBH), lastValidBlockHeight: LVBH, ...extra });
async function call(payload: unknown, ip = "203.0.113.10") {
  const response = await POST(new Request("http://localhost/api/tx-simulate", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(payload) }));
  return { status: response.status, json: await response.json() as Record<string, unknown>, cache: response.headers.get("cache-control") };
}
const connection = {
  getBlockHeight: vi.fn(async () => LVBH - 10),
  simulateTransaction: vi.fn(async () => ({ value: { err: null, logs: [], unitsConsumed: 5_000 } })),
  sendRawTransaction: vi.fn(),
};
beforeEach(() => {
  resetTxSendRateLimit();
  for (const fn of Object.values(connection)) fn.mockClear();
  vi.mocked(rpcConnection).mockClear().mockReturnValue(connection as never);
});

describe("POST /api/tx-simulate", () => {
  it("simulates on public RPC only and answers { ok, unitsConsumed } with no-store, never sending", async () => {
    expect(await call(body())).toEqual({ status: 200, json: { ok: true, unitsConsumed: 5_000 }, cache: "no-store" });
    expect(vi.mocked(rpcConnection)).toHaveBeenCalledWith({}, { env: {}, retry: null });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("a failed simulation answers { ok: false, cause } in plain words", async () => {
    connection.simulateTransaction.mockResolvedValueOnce({ value: { err: { InstructionError: [0, { Custom: 1 }] }, logs: [] } } as never);
    const { status, json } = await call(body());
    expect(status).toBe(200);
    expect(Object.keys(json).sort()).toEqual(["cause", "ok"]);
    expect(json.ok).toBe(false); expect(json.cause).toEqual(expect.any(String)); expect(String(json.cause)).not.toMatch(/[{}"]/);
  });
  it("refuses once the transaction's lastValidBlockHeight has passed (expired, without simulating)", async () => {
    connection.getBlockHeight.mockResolvedValueOnce(LVBH + 1);
    expect((await call(body())).json).toEqual({ ok: false, cause: SIM_EXPIRED_CAUSE });
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });
  it("a missing or bad permit is 400 (a send permit, another wallet's bytes, a wrong height)", async () => {
    const other = txFor(82);
    for (const payload of [body(prepared, { landedPermit: undefined }), body(prepared, { landedPermit: "x".repeat(64) }),
      body(prepared, { landedPermit: sendPermitFor(WALLET, toBase64(prepared), SIGNING_SECRET) }),
      { ...body(other), landedPermit: body().landedPermit }, body(prepared, { lastValidBlockHeight: LVBH + 1 }), null]) {
      expect((await call(payload)).status).toBe(400);
    }
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });
  it("rejects oversized input", async () => {
    expect((await call(body(prepared, { unsignedTransaction: "A".repeat(PERMITTED_TX_MAX_BASE64 + 1) }))).status).toBe(400);
    expect(connection.simulateTransaction).not.toHaveBeenCalled();
  });
  it("is rate limited per IP (429, counted as unavailable by the browser)", async () => {
    for (let i = 0; i < TX_SIMULATE_REQUESTS_PER_IP_PER_MINUTE; i++) await call(body(txFor(100 + i)));
    expect(await call(body(txFor(200)))).toMatchObject({ status: 429, json: { ok: null, unavailable: true } });
  });
  it("is rate limited per permit and per wallet, after the permit is verified", async () => {
    for (let i = 0; i < TX_SIMULATE_REQUESTS_PER_CHECK_PER_MINUTE; i++) expect((await call(body(), `198.51.100.${i}`)).status).toBe(200);
    expect((await call(body(), "198.51.100.99")).status).toBe(429);
    resetTxSendRateLimit();
    // Same wallet, a new permit for each request (different heights), from different IPs.
    const permitAt = (height: number) => body(prepared, { lastValidBlockHeight: height,
      landedPermit: issueTxLandedPermit(SIGNING_SECRET, WALLET, prepared.serialize(), height) });
    for (let i = 0; i < TX_SIMULATE_REQUESTS_PER_WALLET_PER_MINUTE; i++) expect((await call(permitAt(LVBH + i), `192.0.2.${i}`)).status).toBe(200);
    expect((await call(permitAt(LVBH + 500), "192.0.2.200")).status).toBe(429);
  });
});
