import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@sofinance/engine/wallet-discovery", () => ({ discoverWallet: vi.fn() }));
vi.mock("../lib/position-performance", () => ({ getPositionPerformance: vi.fn() }));
vi.mock("../lib/position-range-onchain", () => ({ readPositionRangeFacts: vi.fn() }));
vi.mock("../lib/orca-positions", () => ({
  ORCA_PROTOCOL: "orca-whirlpool",
  listOrcaPositions: vi.fn(async () => []),
  getOrcaPositionPerformance: vi.fn(async () => null),
  readOrcaPositionRangeFacts: vi.fn(async () => null),
}));
vi.mock("../lib/meteora-positions", () => ({
  METEORA_PROTOCOL: "meteora-dlmm",
  listMeteoraPositions: vi.fn(),
  readMeteoraPositionRangeFacts: vi.fn(),
}));

const { discoverWallet } = await import("@sofinance/engine/wallet-discovery");
const { readPositionRangeFacts } = await import("../lib/position-range-onchain");
const orca = await import("../lib/orca-positions");
const meteora = await import("../lib/meteora-positions");
const { getPositionRangeStatus, listPositions } = await import("./tools");

const WALLET = "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3";
const raydiumRow = { positionMint: "m", positionAccount: "a", poolId: "p", mintA: "A", mintB: "B", tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };
const meteoraRow = { ...raydiumRow, positionMint: "pos", positionAccount: "pos", protocol: "meteora-dlmm" };
const facts = { positionMint: "m", poolId: "p", mintA: "A", mintB: "B", decimalsA: 8, decimalsB: 8, tickLower: -10, tickUpper: 10, tickCurrent: 0, onChainPriceBPerA: 1 };

describe("MCP Meteora routing (METEORA_DLMM_DISCOVERY_ENABLED)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverWallet).mockResolvedValue({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow], assets: [] } as never);
    vi.mocked(meteora.listMeteoraPositions).mockResolvedValue([meteoraRow] as never);
    vi.mocked(readPositionRangeFacts).mockResolvedValue(facts);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("production: never calls Meteora code and returns the Raydium shape unchanged", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect(await listPositions({ wallet: WALLET })).toEqual({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow], assets: [] });
    const range = await getPositionRangeStatus({ positionMint: "m" } as never);
    expect(range).not.toHaveProperty("protocol");
    expect(meteora.listMeteoraPositions).not.toHaveBeenCalled();
    expect(meteora.readMeteoraPositionRangeFacts).not.toHaveBeenCalled();
  });

  it("preview: appends shown Meteora positions and reports Meteora failures separately", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await listPositions({ wallet: WALLET })).positions).toEqual([raydiumRow, meteoraRow]);
    vi.mocked(meteora.listMeteoraPositions).mockRejectedValue(new Error("rpc down"));
    const degraded = await listPositions({ wallet: WALLET });
    expect(degraded.positions).toEqual([raydiumRow]);
    expect(degraded.protocolErrors).toEqual([{ protocol: "meteora-dlmm", error: expect.any(String) }]);
    vi.mocked(orca.listOrcaPositions).mockRejectedValueOnce(new Error("orca down"));
    expect((await listPositions({ wallet: WALLET })).protocolErrors?.map((item) => item.protocol)).toEqual(["orca-whirlpool", "meteora-dlmm"]);
  });

  it("preview: range status routes Meteora position accounts after Orca and before Raydium", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(meteora.readMeteoraPositionRangeFacts)
      .mockResolvedValueOnce({ ...facts, positionMint: "pos", protocol: "meteora-dlmm", lowerBinId: -10, upperBinId: 9, activeBinId: 0, activeBinPriceBPerA: 1 } as never)
      .mockResolvedValueOnce(null);
    expect(await getPositionRangeStatus({ positionMint: "pos" } as never)).toMatchObject({ protocol: "meteora-dlmm", positionMint: "pos", rangeSide: "inside", activeBinId: 0 });
    expect(await getPositionRangeStatus({ positionMint: "m" } as never)).not.toHaveProperty("protocol");
    expect(readPositionRangeFacts).toHaveBeenCalledTimes(1);

    vi.mocked(orca.readOrcaPositionRangeFacts).mockResolvedValueOnce({ ...facts, positionMint: "om" });
    expect(await getPositionRangeStatus({ positionMint: "om" } as never)).toMatchObject({ protocol: "orca-whirlpool" });
    expect(meteora.readMeteoraPositionRangeFacts).toHaveBeenCalledTimes(2);
  });
});
