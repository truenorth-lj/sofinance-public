import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { clearRwaPairsCache, discoverRwaPairs, parseRaydiumPoolAsRwaPair } from "./rwa-pairs";
import { TOKEN_2022_PROGRAM_ID } from "./rwa-pairing";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function poolFixture(overrides: Record<string, unknown> = {}) {
  return {
    type: "Concentrated",
    id: "Pool1111111111111111111111111111111111111",
    feeRate: 0.0005,
    tvl: 10_000,
    mintA: {
      address: "MintA1111111111111111111111111111111111111",
      symbol: "MSTRx",
      name: "MicroStrategy xStock",
      programId: TOKEN_2022_PROGRAM_ID,
      tags: ["hasFreeze"],
      extensions: { tips: { text: "This is a Backed tokenized equity." } },
    },
    mintB: {
      address: "MintB1111111111111111111111111111111111111",
      symbol: "MSTR",
      name: "Strategy - Backpack Securities",
      programId: TOKEN_2022_PROGRAM_ID,
      tags: ["hasFreeze"],
      extensions: {},
    },
    day: {
      volume: 50_000,
      volumeFee: 25,
      feeApr: 91.25,
    },
    ...overrides,
  };
}

describe("parseRaydiumPoolAsRwaPair", () => {
  it("parses a matching CLMM pool with yield metrics and risk flags", () => {
    const row = parseRaydiumPoolAsRwaPair(poolFixture());
    expect(row).not.toBeNull();
    expect(row!.poolAddress).toMatch(/^Pool/);
    expect(row!.wrappedSymbol).toBe("MSTRx");
    expect(row!.plainSymbol).toBe("MSTR");
    expect(row!.feeTierBps).toBeCloseTo(5, 5);
    expect(row!.tvlUsd).toBe(10_000);
    expect(row!.volume24hUsd).toBe(50_000);
    expect(row!.fees24hUsd).toBe(25);
    expect(row!.raydiumFeeApr24h).toBe(91.25);
    expect(row!.estimatedFeeAprPct).toBeCloseTo(91.25, 6);
    expect(row!.estimatedFeeAprLabel).toMatch(/24h pool fees/i);
    expect(row!.token2022A).toBe(true);
    expect(row!.freezeRisk).toBe(true);
  });

  it("returns null for RWA/USDC pools", () => {
    const row = parseRaydiumPoolAsRwaPair(
      poolFixture({
        mintB: {
          address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
          symbol: "USDC",
          name: "USD Coin",
          programId: TOKEN_PROGRAM,
          tags: ["hasFreeze"],
          extensions: {},
        },
      }),
    );
    expect(row).toBeNull();
  });

  it("returns null for malformed rows", () => {
    expect(parseRaydiumPoolAsRwaPair(null)).toBeNull();
    expect(parseRaydiumPoolAsRwaPair({ id: "x" })).toBeNull();
  });
});

describe("discoverRwaPairs", () => {
  afterEach(() => {
    clearRwaPairsCache();
    vi.restoreAllMocks();
  });

  it("filters and sorts pairs from mocked Raydium pages", async () => {
    const matching = poolFixture();
    const unrelated = poolFixture({
      id: "PoolUnrelated000000000000000000000000001",
      mintA: {
        address: "So11111111111111111111111111111111111111112",
        symbol: "WSOL",
        name: "Wrapped SOL",
        programId: TOKEN_PROGRAM,
        tags: [],
        extensions: {},
      },
      mintB: {
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        symbol: "USDC",
        name: "USD Coin",
        programId: TOKEN_PROGRAM,
        tags: ["hasFreeze"],
        extensions: {},
      },
    });
    const lowTvl = poolFixture({
      id: "PoolLowTvl00000000000000000000000000001",
      tvl: 1,
      day: { volume: 0, volumeFee: 0, feeApr: 0 },
      mintA: {
        address: "MintC1111111111111111111111111111111111111",
        symbol: "NVDAx",
        name: "NVIDIA xStock",
        programId: TOKEN_2022_PROGRAM_ID,
        tags: ["hasFreeze"],
        extensions: {},
      },
      mintB: {
        address: "MintD1111111111111111111111111111111111111",
        symbol: "NVDA",
        name: "NVDA",
        programId: TOKEN_2022_PROGRAM_ID,
        tags: ["hasFreeze"],
        extensions: {},
      },
    });

    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: { count: 3, data: [matching, unrelated, lowTvl], hasNextPage: false },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const result = await discoverRwaPairs({
      minTvl: 10,
      maxPages: 1,
      sortBy: "estimatedFeeApr",
      fetcher: fetcher as unknown as typeof fetch,
      bypassCache: true,
    });

    expect(result.scannedPools).toBe(3);
    expect(result.pagesFetched).toBe(1);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.wrappedSymbol).toBe("MSTRx");
    expect(result.pairs[0]!.estimatedFeeAprPct).toBeCloseTo(91.25, 5);
    expect(result.pairingRuleSummary).toMatch(/FOOx\/FOO/);
    expect(result.source).toMatch(/api-v3\.raydium\.io/);
  });
});
