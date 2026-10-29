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
}));
// Meteora routing is covered in tools.meteora.test.ts; here it finds nothing.
vi.mock("../lib/meteora-positions", () => ({
  METEORA_PROTOCOL: "meteora-dlmm",
  listMeteoraPositions: vi.fn(async () => []),
  readMeteoraPositionRangeFacts: vi.fn(async () => null),
}));

const { discoverWallet } = await import("@sofinance/engine/wallet-discovery");
const { getPositionPerformance: readRaydiumPerformance } = await import("../lib/position-performance");
const { readPositionRangeFacts } = await import("../lib/position-range-onchain");
const orca = await import("../lib/orca-positions");
const { getPositionPerformance, getPositionRangeStatus, listPositions } = await import("./tools");

const WALLET = "7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3";
const raydiumRow = { positionMint: "m", positionAccount: "a", poolId: "p", mintA: "A", mintB: "B", tickLower: -10, tickUpper: 10, tickCurrent: 0, rangeSide: "inside", liquidity: "1" };
const orcaRow = { ...raydiumRow, positionMint: "om", protocol: "orca-whirlpool" };
const facts = { positionMint: "m", poolId: "p", mintA: "A", mintB: "B", decimalsA: 8, decimalsB: 8, tickLower: -10, tickUpper: 10, tickCurrent: 0, onChainPriceBPerA: 1 };

describe("MCP Orca routing (ORCA_POSITIONS_ENABLED)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discoverWallet).mockResolvedValue({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow], assets: [] } as never);
    vi.mocked(orca.listOrcaPositions).mockResolvedValue([orcaRow] as never);
    vi.mocked(readPositionRangeFacts).mockResolvedValue(facts);
  });
  afterEach(() => vi.unstubAllEnvs());

  it("production: never calls Orca code and returns the Raydium shape unchanged", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    const listed = await listPositions({ wallet: WALLET });
    expect(listed).toEqual({ wallet: WALLET, slot: 1, fetchedAt: 1, positions: [raydiumRow], assets: [] });
    vi.mocked(readRaydiumPerformance).mockResolvedValue({ metrics: {}, history: [] } as never);
    const performance = await getPositionPerformance({ positionMint: "m" } as never);
    expect(performance).not.toHaveProperty("protocol");
    const range = await getPositionRangeStatus({ positionMint: "m" } as never);
    expect(range).not.toHaveProperty("protocol");
    expect(orca.listOrcaPositions).not.toHaveBeenCalled();
    expect(orca.getOrcaPositionPerformance).not.toHaveBeenCalled();
    expect(orca.readOrcaPositionRangeFacts).not.toHaveBeenCalled();
    expect(range).toMatchObject({ priceSource: "on-chain" });
  });

  it("preview: appends shown Orca positions after Raydium rows and reports Orca failures separately", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    expect((await listPositions({ wallet: WALLET })).positions).toEqual([raydiumRow, orcaRow]);
    vi.mocked(orca.listOrcaPositions).mockRejectedValue(new Error("rpc down"));
    const degraded = await listPositions({ wallet: WALLET });
    expect(degraded.positions).toEqual([raydiumRow]);
    expect(degraded).toMatchObject({ protocolErrors: [{ protocol: "orca-whirlpool", error: expect.any(String) }] });
  });

  it("preview: routes Orca mints to Orca readers and everything else to Raydium", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.mocked(orca.getOrcaPositionPerformance).mockResolvedValueOnce({ metrics: {}, history: [], poolId: "op" } as never).mockResolvedValueOnce(null);
    vi.mocked(readRaydiumPerformance).mockResolvedValue({ metrics: {}, history: [], poolId: "rp" } as never);
    expect(await getPositionPerformance({ positionMint: "om" } as never)).toMatchObject({ protocol: "orca-whirlpool", poolId: "op" });
    const raydium = await getPositionPerformance({ positionMint: "m" } as never);
    expect(raydium).not.toHaveProperty("protocol");
    expect(raydium.poolId).toBe("rp");

    vi.mocked(orca.readOrcaPositionRangeFacts).mockResolvedValueOnce({ ...facts, positionMint: "om" }).mockResolvedValueOnce(null);
    expect(await getPositionRangeStatus({ positionMint: "om" } as never)).toMatchObject({ protocol: "orca-whirlpool", positionMint: "om", rangeSide: "inside" });
    expect(await getPositionRangeStatus({ positionMint: "m" } as never)).not.toHaveProperty("protocol");
    expect(readPositionRangeFacts).toHaveBeenCalledTimes(1);
  });

  it("preview: a missing opens database is reported as a protocol error, not an empty list", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const { ORCA_OPENS_DB_MISSING } = await vi.importActual<typeof import("../lib/orca-positions")>("../lib/orca-positions");
    vi.mocked(orca.listOrcaPositions).mockRejectedValue(new Error(ORCA_OPENS_DB_MISSING));
    const listed = await listPositions({ wallet: WALLET });
    expect(listed.positions).toEqual([raydiumRow]);
    expect(listed.protocolErrors).toEqual([{ protocol: "orca-whirlpool", error: ORCA_OPENS_DB_MISSING }]);
    const { publicToolError } = await import("./public-tool-error");
    expect(publicToolError(new Error(ORCA_OPENS_DB_MISSING))).toBe(ORCA_OPENS_DB_MISSING);
  });
});
