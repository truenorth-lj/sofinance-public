import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/open-atomic", () => ({ buildAndSimulateOpenPosition: vi.fn() }));
vi.mock("@/lib/open-permit", () => ({ issueOpenPositionPermit: vi.fn(() => "permit") }));

import { buildAndSimulateOpenPosition } from "@/lib/open-atomic";
import { POST } from "./route";

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
        rangePreset: "standard", toleranceBps: 100, resaleFloorBps: 9900 }),
    }));
    expect(response.status).toBe(200);
    expect(buildAndSimulateOpenPosition).toHaveBeenCalledWith(wallet,
      { poolId, inputMint, inputKind: "token" }, "0.12", { preset: "standard" }, 9900, 100,
      { enforceResaleFloor: false });
    const body = await response.json();
    expect(body.unsignedTransaction).toBe(Buffer.from("transaction").toString("base64"));
  });
});
