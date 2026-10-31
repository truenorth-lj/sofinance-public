// POST /api/tx-landed: read-only, bound to a check permit that signs the prepare-time lastValidBlockHeight, refused
// once that blockhash is long expired, rate limited (IP, check, wallet), cached ~2 s; RPC trouble is a plain 502.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async (original) => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: () => "test-signing-secret-not-a-real-key",
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { resetTxLandedCache } from "@/lib/tx-landed/cache";
import { LANDED_CHECK_WINDOW_BLOCKS, LANDED_EXPIRY_MARGIN_BLOCKS } from "@/lib/tx-landed/lookup";
import { issueTxLandedPermit, sendPermitFor } from "@/lib/tx-send/permit";
import { resetTxSendRateLimit, TX_LANDED_REQUESTS_PER_CHECK_PER_MINUTE, TX_LANDED_REQUESTS_PER_IP_PER_MINUTE,
  TX_LANDED_REQUESTS_PER_WALLET_PER_MINUTE } from "@/lib/tx-send/rate-limit";
import { POST } from "./route";

const payer = testKeypair(71);
const WALLET = payer.publicKey.toBase58();
const prepared = buildTransaction({ payer, signWith: [] });
const HEIGHT = 1_000;
const LVBH = 990;
const landedPermit = (lvbh = LVBH) => issueTxLandedPermit(SIGNING_SECRET, WALLET, prepared.serialize(), lvbh);
const SIG = bs58.encode(new Uint8Array(64).fill(6));
const nowSeconds = () => Math.floor(Date.now() / 1000);
const body = (extra: Record<string, unknown> = {}) =>
  ({ unsignedTransaction: toBase64(prepared), landedPermit: landedPermit(), lastValidBlockHeight: LVBH, preparedAt: Date.now(), ...extra });
async function call(payload: unknown, ip = "203.0.113.9") {
  const response = await POST(new Request("http://localhost/api/tx-landed", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(payload) }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
const landedHistory = (blockTime = nowSeconds()) => [{ signature: SIG, blockTime, slot: 1, err: null, memo: null }];
const connection = {
  getEpochInfo: vi.fn(async () => ({ blockHeight: HEIGHT, absoluteSlot: 7_000, epoch: 1, slotIndex: 1, slotsInEpoch: 432_000 })),
  getSignaturesForAddress: vi.fn(async () => landedHistory()),
  getTransaction: vi.fn(async () => ({ transaction: { message: prepared.message }, meta: { err: null, loadedAddresses: null } })),
  sendRawTransaction: vi.fn(),
};
beforeEach(() => {
  resetTxSendRateLimit();
  resetTxLandedCache();
  for (const fn of Object.values(connection)) fn.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(rpcConnection).mockReturnValue(connection as never);
});
afterEach(() => { vi.restoreAllMocks(); });

describe("POST /api/tx-landed", () => {
  it("finds the prepared transaction and never sends anything", async () => {
    expect(await call(body())).toEqual({ status: 200, json: { status: "landed", signature: SIG } });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("only checks transactions this app prepared (check permit required; a send permit is not one)", async () => {
    const sendPermit = sendPermitFor(WALLET, toBase64(prepared), SIGNING_SECRET);
    for (const payload of [body({ landedPermit: undefined }), body({ landedPermit: "x".repeat(64) }), body({ landedPermit: sendPermit }),
      body({ unsignedTransaction: toBase64(buildTransaction({ payer: testKeypair(72), signWith: [] })) })]) {
      const { status, json } = await call(payload);
      expect(status).toBe(400); expect(JSON.stringify(json)).not.toMatch(/secret|permit=/i);
    }
    expect(connection.getEpochInfo).not.toHaveBeenCalled();
  });
  it("permit replay: the signed lastValidBlockHeight cannot be stretched to keep a check alive", async () => {
    // Same permit, later height (the client trying to extend the window): refused before any RPC.
    expect((await call(body({ lastValidBlockHeight: LVBH + 10_000 }))).status).toBe(400);
    expect(connection.getEpochInfo).not.toHaveBeenCalled();
    // The genuine permit is refused once the chain is past lastValidBlockHeight + margin + window.
    connection.getEpochInfo.mockResolvedValueOnce({ blockHeight: LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + LANDED_CHECK_WINDOW_BLOCKS + 1,
      absoluteSlot: 9_000, epoch: 1, slotIndex: 1, slotsInEpoch: 432_000 });
    expect(await call(body())).toEqual({ status: 410, json: { error: "This transaction check has expired" } });
    expect(connection.getSignaturesForAddress).not.toHaveBeenCalled();
  });
  it("refuses malformed input", async () => {
    for (const payload of [body({ lastValidBlockHeight: -1 }), body({ preparedAt: "now" }), body({ checked: ["not-a-signature"] }),
      body({ checked: Array(201).fill(SIG) }), body({ unsignedTransaction: "A".repeat(3_000) }), null]) {
      expect((await call(payload)).status).toBe(400);
    }
  });
  it("clock skew: a browser clock running fast cannot end the scan early (cutoff ≤ server now − 300 s)", async () => {
    // Landed 200 s ago by the server clock; the browser claims it prepared an hour from now.
    connection.getSignaturesForAddress.mockResolvedValue(landedHistory(nowSeconds() - 200));
    expect(await call(body({ preparedAt: Date.now() + 3_600_000 }))).toEqual({ status: 200, json: { status: "landed", signature: SIG } });
    // A browser clock running slow cannot widen the scan past 15 minutes: that entry ends the window.
    connection.getSignaturesForAddress.mockResolvedValue(landedHistory(nowSeconds() - 16 * 60));
    resetTxLandedCache();
    expect(await call(body({ preparedAt: Date.now() - 86_400_000 }))).toEqual({ status: 200, json: { status: "pending", checked: [] } });
    expect(connection.getTransaction).toHaveBeenCalledTimes(1);
    connection.getSignaturesForAddress.mockImplementation(async () => landedHistory());
  });
  it("answers RPC trouble with a plain 502, not 'not landed'", async () => {
    connection.getEpochInfo.mockRejectedValueOnce(new Error("fetch failed https://rpc.example/?api-key=hidden"));
    const { status, json } = await call(body());
    expect(status).toBe(502); expect(json).toEqual({ error: "Could not check Solana right now" });
  });
  it("caches an identical poll for ~2 s (one RPC round for a burst)", async () => {
    connection.getSignaturesForAddress.mockResolvedValue([]);
    for (let i = 0; i < 3; i++) expect((await call(body())).json).toEqual({ status: "pending", checked: [] });
    expect(connection.getEpochInfo).toHaveBeenCalledTimes(1);
    connection.getSignaturesForAddress.mockImplementation(async () => landedHistory());
  });
  it("is rate limited per IP (25/min)", async () => {
    expect(TX_LANDED_REQUESTS_PER_IP_PER_MINUTE).toBe(25);
    // 25 different checks from one IP, then refused; another IP is unaffected.
    for (let i = 0; i < TX_LANDED_REQUESTS_PER_IP_PER_MINUTE; i++) {
      expect((await call(body({ lastValidBlockHeight: LVBH - i, landedPermit: landedPermit(LVBH - i) }), "198.51.100.4")).status).toBe(200);
    }
    expect((await call(body(), "198.51.100.4")).status).toBe(429);
    expect((await call(body(), "198.51.100.5")).status).toBe(200);
  });
  it("is rate limited per check permit and per wallet, across IPs", async () => {
    for (let i = 0; i < TX_LANDED_REQUESTS_PER_CHECK_PER_MINUTE; i++) expect((await call(body(), `192.0.2.${i}`)).status).toBe(200);
    expect((await call(body(), "192.0.2.200")).status).toBe(429);
    // Other checks of the same wallet share the per-wallet budget.
    let i = 0;
    while (i < TX_LANDED_REQUESTS_PER_WALLET_PER_MINUTE - TX_LANDED_REQUESTS_PER_CHECK_PER_MINUTE) {
      expect((await call(body({ lastValidBlockHeight: LVBH - 1 - i, landedPermit: landedPermit(LVBH - 1 - i) }), `198.18.0.${i}`)).status).toBe(200);
      i++;
    }
    expect((await call(body({ lastValidBlockHeight: 10, landedPermit: landedPermit(10) }), "198.18.1.1")).status).toBe(429);
  });
});
