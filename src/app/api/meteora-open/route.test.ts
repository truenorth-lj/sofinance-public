import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const prepareMeteoraSetup = vi.fn(async () => ({ step: 1 }));
vi.mock("@/lib/meteora-open", async (orig) => ({ ...(await orig<typeof import("@/lib/meteora-open")>()), prepareMeteoraSetup }));
const recordMeteoraOpen = vi.fn();
vi.mock("@/lib/meteora-open-record", async (orig) => ({ ...(await orig<typeof import("@/lib/meteora-open-record")>()), recordMeteoraOpen }));
vi.mock("@sofinance/engine/rpc", () => ({ rpcConnection: () => ({}) }));

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

const A = "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H";
const setupBody = { action: "setup", wallet: A, poolId: A, inputMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", position: A, amount: "1000000", lowerBinId: 10, upperBinId: 20 };
const req = (body: unknown) => new Request("http://x/api/meteora-open", { method: "POST", body: JSON.stringify(body) });

describe("/api/meteora-open", () => {
  it("is 404 in production (METEORA_DLMM_TX_BUILD_ENABLED off)", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const { POST } = await import("./route");
    expect((await POST(req(setupBody))).status).toBe(404);
    expect(prepareMeteoraSetup).not.toHaveBeenCalled();
  });

  it("builds + simulates on preview", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { POST } = await import("./route");
    const res = await POST(req(setupBody));
    expect(res.status).toBe(200);
    expect(prepareMeteoraSetup).toHaveBeenCalledWith(expect.objectContaining({ amount: 1_000_000n }), expect.anything());
  });

  it("record is 404 while METEORA_DLMM_WALLET_SIGNING_ENABLED is off", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { POST } = await import("./route");
    const sig = "5".repeat(88);
    expect((await POST(req({ action: "record", wallet: A, setupSignature: sig, depositSignature: "4".repeat(88) }))).status).toBe(404);
    expect(recordMeteoraOpen).not.toHaveBeenCalled();
  });

  it("rejects invalid bodies", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { POST } = await import("./route");
    expect((await POST(req({ ...setupBody, amount: "-1" }))).status).toBe(400);
  });
});
