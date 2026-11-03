// POST /api/tx-expiry (pre-wallet guard, no double-landing): after a voided prompt, did the old transaction land, or
// has its blockhash expired? Public RPC only, permit-bound, rate limited; RPC trouble is never "expired".
import { beforeEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async (original) => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: () => "test-signing-secret-not-a-real-key",
}));

import { rpcConnection } from "@sofinance/engine/rpc";
import { buildTransaction, SIGNING_SECRET, testKeypair, toBase64 } from "@/lib/test-support/send-fixtures";
import { LANDED_EXPIRY_MARGIN_BLOCKS } from "@/lib/tx-landed/lookup";
import { PERMITTED_TX_MAX_BASE64 } from "@/lib/tx-simulate/permitted-input.server";
import { issueTxLandedPermit } from "@/lib/tx-send/permit";
import { resetTxSendRateLimit, TX_EXPIRY_REQUESTS_PER_CHECK_PER_MINUTE } from "@/lib/tx-send/rate-limit";
import { POST } from "./route";

const payer = testKeypair(91);
const WALLET = payer.publicKey.toBase58();
const prepared = buildTransaction({ payer, signWith: [] });
const LVBH = 990;
const SIG = bs58.encode(new Uint8Array(64).fill(9));
const body = (extra: Record<string, unknown> = {}) => ({ unsignedTransaction: toBase64(prepared),
  landedPermit: issueTxLandedPermit(SIGNING_SECRET, WALLET, prepared.serialize(), LVBH), lastValidBlockHeight: LVBH, preparedAt: Date.now(), ...extra });
async function call(payload: unknown, ip = "203.0.113.11") {
  const response = await POST(new Request("http://localhost/api/tx-expiry", {
    method: "POST", headers: { "Content-Type": "application/json", "x-real-ip": ip }, body: JSON.stringify(payload) }));
  return { status: response.status, json: await response.json() as Record<string, unknown> };
}
let height = LVBH - 5;
const connection = {
  getBlockHeight: vi.fn(async () => height),
  getEpochInfo: vi.fn(async () => ({ blockHeight: height, absoluteSlot: 7_000, epoch: 1, slotIndex: 1, slotsInEpoch: 432_000 })),
  getSignatureStatuses: vi.fn(async () => ({ context: { slot: 1 }, value: [null as null | { confirmationStatus: string; err: unknown }] })),
  getSignaturesForAddress: vi.fn(async () => [] as unknown[]),
  getTransaction: vi.fn(async () => ({ transaction: { message: prepared.message }, meta: { err: null, loadedAddresses: null } })),
  sendRawTransaction: vi.fn(),
};
beforeEach(() => {
  height = LVBH - 5;
  resetTxSendRateLimit();
  for (const fn of Object.values(connection)) fn.mockClear();
  vi.mocked(rpcConnection).mockClear().mockReturnValue(connection as never);
});

describe("POST /api/tx-expiry", () => {
  it("pending while the old blockhash is still valid, with the blocks left (public RPC only)", async () => {
    expect(await call(body())).toEqual({ status: 200, json: { status: "pending", blocksLeft: 5 + LANDED_EXPIRY_MARGIN_BLOCKS, checked: [] } });
    expect(vi.mocked(rpcConnection)).toHaveBeenCalledWith({}, { env: {}, retry: null });
    expect(connection.sendRawTransaction).not.toHaveBeenCalled();
  });
  it("the wallet's late signature landed: landed (getSignatureStatuses)", async () => {
    connection.getSignatureStatuses.mockResolvedValueOnce({ context: { slot: 1 }, value: [{ confirmationStatus: "confirmed", err: null }] });
    expect((await call(body({ signature: SIG }))).json).toEqual({ status: "landed", signature: SIG });
  });
  it("without a signature, the prepared transaction found in the fee payer's history: landed", async () => {
    connection.getSignaturesForAddress.mockResolvedValueOnce([{ signature: SIG, blockTime: Math.floor(Date.now() / 1000), slot: 1, err: null, memo: null }]);
    expect((await call(body())).json).toEqual({ status: "landed", signature: SIG });
  });
  it("expired only once the block height is past lastValidBlockHeight (plus margin) with nothing landed", async () => {
    height = LVBH + LANDED_EXPIRY_MARGIN_BLOCKS;
    expect((await call(body({ signature: SIG }))).json).toMatchObject({ status: "pending", blocksLeft: 0 });
    height = LVBH + LANDED_EXPIRY_MARGIN_BLOCKS + 1;
    expect((await call(body({ signature: SIG }))).json).toEqual({ status: "expired" });
    expect((await call(body())).json).toEqual({ status: "expired" });
  });
  it("RPC trouble is a 502, never expired", async () => {
    connection.getBlockHeight.mockRejectedValueOnce(new Error("429"));
    expect((await call(body())).status).toBe(502);
  });
  it("a bad or missing permit, a bad signature or oversized input is 400", async () => {
    for (const payload of [body({ landedPermit: undefined }), body({ landedPermit: "x".repeat(64) }), body({ signature: "not-a-signature" }),
      body({ preparedAt: undefined }), body({ unsignedTransaction: "A".repeat(PERMITTED_TX_MAX_BASE64 + 1) })]) {
      expect((await call(payload)).status).toBe(400);
    }
    expect(connection.getBlockHeight).not.toHaveBeenCalled();
  });
  it("is rate limited per permit", async () => {
    for (let i = 0; i < TX_EXPIRY_REQUESTS_PER_CHECK_PER_MINUTE; i++) await call(body(), `198.51.100.${i}`);
    expect((await call(body(), "198.51.100.250")).status).toBe(429);
  });
});
