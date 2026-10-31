import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/server/transactions/open-prepare", () => ({ prepareOpen: vi.fn() }));
vi.mock("@sofinance/engine/config/server-env", async original => ({
  ...await original<typeof import("@sofinance/engine/config/server-env")>(), getSigningSecret: vi.fn(),
}));

import { getSigningSecret } from "@sofinance/engine/config/server-env";
import { prepareOpen } from "@/server/transactions/open-prepare";
import { createSignToken, type PendingSignPayload } from "@/lib/pending-sign-token";
import { MCP_OPEN_PREPARE } from "@/server/transactions/surface-policy";
import { jsonRequest, SIGNING_SECRET, testKeypair } from "@/lib/test-support/send-fixtures";
import { verifyTxSendPermit } from "@/lib/tx-send/permit";
import { POST } from "./route";

const wallet = testKeypair(1).publicKey.toBase58();
const nftMint = testKeypair(2).publicKey.toBase58();
const openRequest = { selection: { poolId: testKeypair(3).publicKey.toBase58(), inputMint: testKeypair(4).publicKey.toBase58(), inputKind: "token" as const },
  amount: "1", range: { preset: "standard" as const }, floorBps: 9900, toleranceBps: 100 };
const payload = (overrides: Partial<PendingSignPayload> = {}): PendingSignPayload => ({
  kind: "open-position", wallet, unsignedTransaction: "preview", permit: "p", submitArgs: { wallet }, expiresAt: Date.now() + 60_000, openRequest, ...overrides,
});
const preparedTx = Buffer.from("re-prepared open transaction bytes").toString("base64");
const post = (body: unknown) => POST(jsonRequest("http://localhost/api/sign-open-prepare", body));

describe("POST /api/sign-open-prepare", () => {
  beforeEach(() => {
    vi.mocked(getSigningSecret).mockReturnValue(SIGNING_SECRET);
    vi.mocked(prepareOpen).mockReset().mockResolvedValue({ summary: { nftMint } as never, permit: "fresh", unsignedTransaction: preparedTx });
  });

  it("re-prepares with the token's HMAC-bound inputs, the browser mint public key and the MCP profile", async () => {
    const response = await post({ token: await createSignToken(payload(), SIGNING_SECRET), nftMint });
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toMatchObject({ summary: { nftMint }, permit: "fresh", unsignedTransaction: preparedTx });
    expect(prepareOpen).toHaveBeenCalledWith({ wallet, ...openRequest, nftMint }, expect.any(Function), MCP_OPEN_PREPARE);
  });

  it("adds a /api/tx-send permit for the re-prepared transaction even though the MCP profile issues none", async () => {
    // prepareOpen (MCP profile) returns no sendPermit; the sign page still relays (mint co-signs after the wallet).
    const response = await post({ token: await createSignToken(payload(), SIGNING_SECRET), nftMint });
    const { sendPermit } = await response.json() as { sendPermit?: string };
    expect(sendPermit).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyTxSendPermit(SIGNING_SECRET, wallet, Buffer.from(preparedTx, "base64"), sendPermit)).toBe(true);
    expect(verifyTxSendPermit(SIGNING_SECRET, testKeypair(9).publicKey.toBase58(), Buffer.from(preparedTx, "base64"), sendPermit)).toBe(false);
  });

  it.each([
    ["forged token", async () => ({ token: await createSignToken(payload(), "other-secret"), nftMint })],
    ["token without openRequest", async () => ({ token: await createSignToken(payload({ openRequest: undefined }), SIGNING_SECRET), nftMint })],
    ["non-open token", async () => ({ token: await createSignToken(payload({ kind: "compound" }), SIGNING_SECRET), nftMint })],
    ["expired token", async () => ({ token: await createSignToken(payload({ expiresAt: Date.now() - 1 }), SIGNING_SECRET), nftMint })],
    ["invalid mint", async () => ({ token: await createSignToken(payload(), SIGNING_SECRET), nftMint: "not-a-key" })],
    ["wallet as mint", async () => ({ token: await createSignToken(payload(), SIGNING_SECRET), nftMint: wallet })],
    ["missing fields", async () => ({})],
  ])("rejects %s without preparing", async (_name, body) => {
    const response = await post(await body());
    expect(response.status).toBe(400);
    expect(prepareOpen).not.toHaveBeenCalled();
  });
});
