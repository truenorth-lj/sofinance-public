import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/tx-send/permit", () => ({ sendPermitFor: vi.fn(() => "send-permit"), txPermitsFor: vi.fn(() => ({ sendPermit: "send-permit", landedPermit: "landed-permit" })) }));
vi.mock("@sofinance/engine/open-atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@sofinance/engine/open-atomic")>()),
  buildAndSimulateOpenPosition: vi.fn(),
}));
vi.mock("@/lib/open-permit", () => ({ issueOpenPositionPermit: vi.fn(() => "permit") }));

import { buildAndSimulateOpenPosition } from "@sofinance/engine/open-atomic";
import { POST } from "./route";
import { testKeypair } from "@/lib/test-support/send-fixtures";

const nftMint = testKeypair(6).publicKey.toBase58();

beforeEach(() => { vi.clearAllMocks(); });

describe("open-position preparation API", () => {
  it("prepares with price tolerance and does not enforce the default resale floor", async () => {
    const wallet = "11111111111111111111111111111111";
    const poolId = "So11111111111111111111111111111111111111112";
    const inputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const summary = {
      operation: "open-position" as const, simulated: true, expiresAt: Date.now() + 75000,
      quote: { requested: "120000000", maxImpactBps: 500 },
    };
    vi.mocked(buildAndSimulateOpenPosition).mockResolvedValue({
      summary,
      transaction: { message: { serialize: () => Buffer.from("message") }, serialize: () => Buffer.from("transaction") },
    } as unknown as Awaited<ReturnType<typeof buildAndSimulateOpenPosition>>);
    const response = await POST(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet, poolId, inputMint, inputKind: "token", amount: "0.12",
        rangePreset: "standard", toleranceBps: 100, resaleFloorBps: 9900, nftMint }),
    }));
    expect(response.status).toBe(200);
    expect(buildAndSimulateOpenPosition).toHaveBeenCalledWith(wallet,
      { poolId, inputMint, inputKind: "token" }, "0.12", { preset: "standard" }, 9900, 100,
      { enforceResaleFloor: false, nftMint });
    const body = await response.json();
    expect(body.unsignedTransaction).toBe(Buffer.from("transaction").toString("base64"));
  });

  it("retries once when the RPC fee estimate is empty", async () => {
    vi.mocked(buildAndSimulateOpenPosition)
      .mockRejectedValueOnce(new Error("Unable to estimate complete transaction network fee"))
      .mockResolvedValue({
        summary: { operation: "open-position", simulated: true, expiresAt: Date.now() + 75000, quote: {} },
        transaction: { message: { serialize: () => Buffer.from("message") }, serialize: () => Buffer.from("transaction") },
      } as never);
    const response = await POST(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        wallet: "11111111111111111111111111111111",
        poolId: "So11111111111111111111111111111111111111112",
        inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        inputKind: "token", amount: "0.12", rangePreset: "standard", nftMint,
      }),
    }));
    expect(response.status).toBe(200);
    expect(buildAndSimulateOpenPosition).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing or invalid NFT mint without building", async () => {
    const body = {
      wallet: "11111111111111111111111111111111",
      poolId: "So11111111111111111111111111111111111111112",
      inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      inputKind: "token", amount: "0.12", rangePreset: "standard",
    };
    const missing = await POST(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }));
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: "Position NFT mint is required" });
    const invalid = await POST(new Request("http://localhost/api/open-prepare", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, nftMint: "not-a-mint" }),
    }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: "Invalid position NFT mint" });
    expect(buildAndSimulateOpenPosition).not.toHaveBeenCalled();
  });
});
