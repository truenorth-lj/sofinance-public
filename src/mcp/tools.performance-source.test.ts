import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: vi.fn() }));
vi.mock("../lib/position-performance", () => ({ getPositionPerformance: vi.fn() }));
vi.mock("../lib/position-range-onchain", () => ({ readPositionRangeFacts: vi.fn() }));
vi.mock("../lib/orca-positions", () => ({
  ORCA_PROTOCOL: "orca-whirlpool",
  listOrcaPositions: vi.fn(),
  getOrcaPositionPerformance: vi.fn(),
  readOrcaPositionRangeFacts: vi.fn(),
  positionMintLooksLikeOrca: vi.fn(),
}));
vi.mock("../lib/meteora-positions", () => ({
  METEORA_PROTOCOL: "meteora-dlmm",
  listMeteoraPositions: vi.fn(),
  readMeteoraPositionRangeFacts: vi.fn(),
  getMeteoraPositionPerformance: vi.fn(),
  positionAccountLooksLikeMeteora: vi.fn(),
}));

const { getPositionPerformance: readRaydiumPerformance } = await import("../lib/position-performance");
const orca = await import("../lib/orca-positions");
const meteora = await import("../lib/meteora-positions");
const { getPositionPerformance, performanceSourceFor } = await import("./tools");

describe("performanceSourceFor (B6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(orca.positionMintLooksLikeOrca).mockResolvedValue(false);
    vi.mocked(meteora.positionAccountLooksLikeMeteora).mockResolvedValue(false);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("production: returns raydium without looking at Orca or Meteora accounts", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    await expect(performanceSourceFor("m")).resolves.toBe("raydium");
    expect(orca.positionMintLooksLikeOrca).not.toHaveBeenCalled();
    expect(meteora.positionAccountLooksLikeMeteora).not.toHaveBeenCalled();
  });

  it("preview: resolves the source once and calls only that DEX reader", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(orca.positionMintLooksLikeOrca).mockImplementation(async (mint: string) => mint === "om");
    vi.mocked(meteora.positionAccountLooksLikeMeteora).mockImplementation(async (id: string) => id === "pos");
    vi.mocked(orca.getOrcaPositionPerformance).mockResolvedValue({ metrics: {}, history: [], poolId: "op" } as never);
    vi.mocked(meteora.getMeteoraPositionPerformance).mockResolvedValue({ metrics: {}, history: [], poolId: "mp" } as never);
    vi.mocked(readRaydiumPerformance).mockResolvedValue({ metrics: {}, history: [], poolId: "rp" } as never);

    await expect(performanceSourceFor("om")).resolves.toBe("orca");
    await expect(performanceSourceFor("pos")).resolves.toBe("meteora");
    await expect(performanceSourceFor("m")).resolves.toBe("raydium");

    expect(await getPositionPerformance({ positionMint: "om" } as never)).toMatchObject({ protocol: "orca-whirlpool", poolId: "op" });
    expect(await getPositionPerformance({ positionMint: "pos" } as never)).toMatchObject({ protocol: "meteora-dlmm", poolId: "mp" });
    expect(await getPositionPerformance({ positionMint: "m" } as never)).toMatchObject({ poolId: "rp" });
    expect(orca.getOrcaPositionPerformance).toHaveBeenCalledTimes(1);
    expect(meteora.getMeteoraPositionPerformance).toHaveBeenCalledTimes(1);
    expect(readRaydiumPerformance).toHaveBeenCalledTimes(1);
  });

  it("preview: an Orca identify throw does not fall through to Meteora or Raydium", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(orca.positionMintLooksLikeOrca).mockRejectedValue(new Error("rpc down"));
    await expect(getPositionPerformance({ positionMint: "om" } as never)).rejects.toThrow("rpc down");
    expect(meteora.positionAccountLooksLikeMeteora).not.toHaveBeenCalled();
    expect(meteora.getMeteoraPositionPerformance).not.toHaveBeenCalled();
    expect(readRaydiumPerformance).not.toHaveBeenCalled();
  });
});
