import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  clearRwaPairsCache,
  discoverRwaPairs,
  getCachedRwaPairs,
  isAllowlistedPoolCandidate,
  parseRaydiumPoolAsRwaPair,
} from "./rwa-pairs";
import { clearJupiterTagsCache } from "./rwa-jupiter-tags";
import { clearXstocksWhitelistCache } from "./rwa-xstocks-whitelist";
import { TOKEN_2022_PROGRAM_ID } from "./rwa-pairing";
import { USDC_MINT, USDC_USDT_CLMM_POOL_ID, USDT_MINT } from "./rwa-allowlist";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const MINT_A = "MintA1111111111111111111111111111111111111";
const MINT_B = "MintB1111111111111111111111111111111111111";
const MINT_C = "MintC1111111111111111111111111111111111111";
const MINT_D = "MintD1111111111111111111111111111111111111";

function poolFixture(overrides: Record<string, unknown> = {}) {
  return {
    type: "Concentrated",
    id: "Pool1111111111111111111111111111111111111",
    feeRate: 0.0005,
    tvl: 10_000,
    mintA: {
      address: MINT_A,
      symbol: "MSTRx",
      name: "MicroStrategy xStock",
      programId: TOKEN_2022_PROGRAM_ID,
      tags: ["hasFreeze"],
      extensions: { tips: { text: "This is a Backed tokenized equity." } },
    },
    mintB: {
      address: MINT_B,
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

const defaultQualifiers = {
  jupiterTagsByMint: new Map<string, string[]>([
    [MINT_A, ["stocks", "rwa", "xstocks"]],
    [MINT_B, ["stocks", "rwa", "backpack"]],
  ]),
  xstocksMints: new Set<string>(),
};

describe("parseRaydiumPoolAsRwaPair", () => {
  it("parses a matching CLMM pool with yield metrics and risk flags", () => {
    const row = parseRaydiumPoolAsRwaPair(poolFixture(), defaultQualifiers);
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
    expect(row!.relatedness).toBe("both-jupiter-tagged");
    expect(row!.preferredTags).toBe(true);
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
      defaultQualifiers,
    );
    expect(row).toBeNull();
  });

  it("returns null when Jupiter tags and whitelist are missing", () => {
    const row = parseRaydiumPoolAsRwaPair(poolFixture(), {
      jupiterTagsByMint: new Map(),
      xstocksMints: new Set(),
    });
    expect(row).toBeNull();
  });

  it("accepts whitelist-only qualification", () => {
    const row = parseRaydiumPoolAsRwaPair(poolFixture(), {
      jupiterTagsByMint: new Map(),
      xstocksMints: new Set([MINT_A, MINT_B]),
    });
    expect(row).not.toBeNull();
    expect(row!.relatedness).toBe("both-whitelisted");
  });

  it("returns null for malformed rows", () => {
    expect(parseRaydiumPoolAsRwaPair(null)).toBeNull();
    expect(parseRaydiumPoolAsRwaPair({ id: "x" })).toBeNull();
  });

  it("accepts the curated USDC/USDT CLMM pool without Jupiter tags", () => {
    const row = parseRaydiumPoolAsRwaPair(
      poolFixture({
        id: USDC_USDT_CLMM_POOL_ID,
        feeRate: 0.0001,
        tvl: 1_930_519.13,
        mintA: {
          address: USDC_MINT,
          symbol: "USDC",
          name: "USD Coin",
          programId: TOKEN_PROGRAM,
          tags: ["hasFreeze"],
          extensions: {},
        },
        mintB: {
          address: USDT_MINT,
          symbol: "USDT",
          name: "USDT",
          programId: TOKEN_PROGRAM,
          tags: ["hasFreeze"],
          extensions: {},
        },
        day: { volume: 2_477_142.39, volumeFee: 247.71, feeApr: 4.68 },
      }),
    );
    expect(row).not.toBeNull();
    expect(row!.wrapKind).toBe("stable");
    expect(row!.relatedness).toBe("allowlisted");
    expect(row!.qualificationA).toBe("allowlist");
    expect(row!.qualificationB).toBe("allowlist");
    expect(row!.wrappedSymbol).toBe("USDC");
    expect(row!.plainSymbol).toBe("USDT");
    expect(row!.baseSymbol).toBe("USD");
    expect(row!.feeTierBps).toBeCloseTo(1, 5);
    expect(row!.token2022A).toBe(false);
    expect(isAllowlistedPoolCandidate({ id: USDC_USDT_CLMM_POOL_ID, mintA: { address: USDC_MINT, symbol: "USDC" }, mintB: { address: USDT_MINT, symbol: "USDT" } })).not.toBeNull();
  });

  it("rejects a different USDC/USDT pool id and a mint mismatch on the allowlisted id", () => {
    expect(
      parseRaydiumPoolAsRwaPair(
        poolFixture({
          id: "DifferentUsdcUsdtPool1111111111111111111",
          mintA: { address: USDC_MINT, symbol: "USDC", name: "USD Coin", programId: TOKEN_PROGRAM, tags: [], extensions: {} },
          mintB: { address: USDT_MINT, symbol: "USDT", name: "USDT", programId: TOKEN_PROGRAM, tags: [], extensions: {} },
        }),
      ),
    ).toBeNull();
    expect(
      parseRaydiumPoolAsRwaPair(
        poolFixture({
          id: USDC_USDT_CLMM_POOL_ID,
          mintA: { address: USDC_MINT, symbol: "USDC", name: "USD Coin", programId: TOKEN_PROGRAM, tags: [], extensions: {} },
          mintB: {
            address: "So11111111111111111111111111111111111111112",
            symbol: "WSOL",
            name: "Wrapped SOL",
            programId: TOKEN_PROGRAM,
            tags: [],
            extensions: {},
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("discoverRwaPairs", () => {
  afterEach(() => {
    clearRwaPairsCache();
    clearJupiterTagsCache();
    clearXstocksWhitelistCache();
    vi.restoreAllMocks();
  });

  it("filters and sorts pairs using Jupiter tags + xStocks whitelist", async () => {
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
    const memeCollision = poolFixture({
      id: "PoolMeme0000000000000000000000000000001",
      mintA: {
        address: MINT_C,
        symbol: "HOODx",
        name: "Robinhood xStock",
        programId: TOKEN_2022_PROGRAM_ID,
        tags: ["hasFreeze"],
        extensions: {},
      },
      mintB: {
        address: MINT_D,
        symbol: "HOOD",
        name: "foreskin",
        programId: TOKEN_PROGRAM,
        tags: [],
        extensions: {},
      },
    });
    const lowTvl = poolFixture({
      id: "PoolLowTvl00000000000000000000000000001",
      tvl: 1,
      day: { volume: 0, volumeFee: 0, feeApr: 0 },
      mintA: {
        address: "MintE1111111111111111111111111111111111111",
        symbol: "NVDAx",
        name: "NVIDIA xStock",
        programId: TOKEN_2022_PROGRAM_ID,
        tags: ["hasFreeze"],
        extensions: {},
      },
      mintB: {
        address: "MintF1111111111111111111111111111111111111",
        symbol: "NVDA",
        name: "NVDA",
        programId: TOKEN_2022_PROGRAM_ID,
        tags: ["hasFreeze"],
        extensions: {},
      },
    });

    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api-v3.raydium.io")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              count: 4,
              data: [matching, unrelated, memeCollision, lowTvl],
              hasNextPage: false,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
            { id: MINT_C, tags: ["stocks", "rwa", "xstocks"] },
            // MINT_D intentionally untagged (meme)
            { id: "MintE1111111111111111111111111111111111111", tags: ["stocks", "rwa"] },
            { id: "MintF1111111111111111111111111111111111111", tags: ["stocks", "rwa"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(
          JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    const result = await discoverRwaPairs({
      minTvl: 10,
      maxPages: 1,
      sortBy: "estimatedFeeApr",
      fetcher: fetcher as unknown as typeof fetch,
      bypassCache: true,
      jupiterApiKey: "test-key",
    });

    expect(result.scannedPools).toBe(4);
    expect(result.pagesFetched).toBe(1);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.wrappedSymbol).toBe("MSTRx");
    expect(result.pairs[0]!.estimatedFeeAprPct).toBeCloseTo(91.25, 5);
    expect(result.pairs[0]!.relatedness).toBe("both-jupiter-tagged");
    expect(result.pairingRuleSummary).toMatch(/Jupiter/i);
    expect(result.pairingRuleSummary).toMatch(/xStocks/i);
    expect(result.source).toMatch(/api-v3\.raydium\.io/);
    expect(result.source).toMatch(/Jupiter/);
    expect(result.source).toMatch(/allowlist/);
    expect(result.pairingRuleSummary).toMatch(/USDC\/USDT/);
  });

  it("merges the curated USDC/USDT pool from the scan and from the ids fallback", async () => {
    const usdcUsdt = poolFixture({
      id: USDC_USDT_CLMM_POOL_ID,
      feeRate: 0.0001,
      tvl: 50_000,
      mintA: { address: USDC_MINT, symbol: "USDC", name: "USD Coin", programId: TOKEN_PROGRAM, tags: ["hasFreeze"], extensions: {} },
      mintB: { address: USDT_MINT, symbol: "USDT", name: "USDT", programId: TOKEN_PROGRAM, tags: ["hasFreeze"], extensions: {} },
      day: { volume: 10_000, volumeFee: 1, feeApr: 0.73 },
    });
    const matching = poolFixture();

    const listThenIds = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/info/list")) {
        return new Response(
          JSON.stringify({ success: true, data: { count: 2, data: [matching, usdcUsdt], hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/pools/info/ids")) {
        return new Response("should not fetch ids when the scan already found the pool", { status: 500 });
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const fromScan = await discoverRwaPairs({
      minTvl: 0, maxPages: 1, sortBy: "tvl", fetcher: listThenIds as unknown as typeof fetch, bypassCache: true, jupiterApiKey: "test-key",
    });
    expect(fromScan.pairs.map((row) => row.poolAddress)).toEqual([USDC_USDT_CLMM_POOL_ID, matching.id]);
    expect(fromScan.pairs[0]!.wrapKind).toBe("stable");
    expect(listThenIds.mock.calls.some((call) => String(call[0]).includes("/pools/info/ids"))).toBe(false);

    const idsFallback = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/pools/info/list")) {
        return new Response(
          JSON.stringify({ success: true, data: { count: 1, data: [matching], hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/pools/info/ids")) {
        expect(url).toContain(USDC_USDT_CLMM_POOL_ID);
        return new Response(JSON.stringify({ success: true, data: [usdcUsdt] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });

    const fromIds = await discoverRwaPairs({
      minTvl: 0, maxPages: 1, sortBy: "tvl", fetcher: idsFallback as unknown as typeof fetch, bypassCache: true, jupiterApiKey: "test-key",
    });
    expect(fromIds.pairs.map((row) => row.poolAddress)).toEqual([USDC_USDT_CLMM_POOL_ID, matching.id]);
    expect(fromIds.pairs[0]!.relatedness).toBe("allowlisted");
  });

  it("returns null from getCachedRwaPairs when cache is empty", () => {
    const cached = getCachedRwaPairs(0, 10, "estimatedFeeApr");
    expect(cached).toBeNull();
  });

  it("returns cached data with metadata when cache exists and is fresh", async () => {
    const matching = poolFixture();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api-v3.raydium.io")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { count: 1, data: [matching], hasNextPage: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(
          JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    // First call populates cache
    await discoverRwaPairs({
      minTvl: 0,
      maxPages: 10,
      sortBy: "estimatedFeeApr",
      fetcher: fetcher as unknown as typeof fetch,
      jupiterApiKey: "test-key",
    });

    // Second call should return cached data
    const cached = getCachedRwaPairs(0, 10, "estimatedFeeApr");
    expect(cached).not.toBeNull();
    expect(cached!.cacheHit).toBe(true);
    expect(cached!.cachedAt).toBeDefined();
    expect(cached!.stale).toBe(false);
    expect(cached!.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(cached!.ageSeconds).toBeLessThan(60);
    expect(cached!.pairs).toHaveLength(1);
  });

  it("marks cached data as stale when age exceeds 1 hour", async () => {
    const matching = poolFixture();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api-v3.raydium.io")) {
        return new Response(
          JSON.stringify({
            success: true,
            data: { count: 1, data: [matching], hasNextPage: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(
          JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    // Populate cache
    await discoverRwaPairs({
      minTvl: 0,
      maxPages: 10,
      sortBy: "estimatedFeeApr",
      fetcher: fetcher as unknown as typeof fetch,
      jupiterApiKey: "test-key",
    });

    // Mock Date.now to simulate 2 hours passing
    const realNow = Date.now;
    const originalTime = realNow();
    vi.spyOn(Date, "now").mockImplementation(() => originalTime + 2 * 3_600_000);

    const cached = getCachedRwaPairs(0, 10, "estimatedFeeApr");
    expect(cached).not.toBeNull();
    expect(cached!.stale).toBe(true);
    expect(cached!.ageSeconds).toBeGreaterThanOrEqual(7200);
    expect(cached!.pairs).toHaveLength(1);

    Date.now = realNow;
  });

  it("prevents stampedes by reusing in-flight refresh promises", async () => {
    const matching = poolFixture();
    let fetchCallCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api-v3.raydium.io/pools/info/list") || url.includes("api-v3.raydium.io") && url.includes("poolType=concentrated")) {
        fetchCallCount += 1;
        // Simulate slow network
        await new Promise((resolve) => setTimeout(resolve, 100));
        return new Response(
          JSON.stringify({
            success: true,
            data: { count: 1, data: [matching], hasNextPage: false },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("/tokens/v2/search")) {
        return new Response(
          JSON.stringify([
            { id: MINT_A, tags: ["stocks", "rwa", "xstocks"] },
            { id: MINT_B, tags: ["stocks", "rwa", "backpack"] },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.includes("api.xstocks.fi")) {
        return new Response(
          JSON.stringify({ nodes: [], page: { currentPage: 1, hasNextPage: false } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });

    // Start three concurrent requests with the same params
    const [result1, result2, result3] = await Promise.all([
      discoverRwaPairs({
        minTvl: 0,
        maxPages: 10,
        sortBy: "estimatedFeeApr",
        fetcher: fetcher as unknown as typeof fetch,
        jupiterApiKey: "test-key",
      }),
      discoverRwaPairs({
        minTvl: 0,
        maxPages: 10,
        sortBy: "estimatedFeeApr",
        fetcher: fetcher as unknown as typeof fetch,
        jupiterApiKey: "test-key",
      }),
      discoverRwaPairs({
        minTvl: 0,
        maxPages: 10,
        sortBy: "estimatedFeeApr",
        fetcher: fetcher as unknown as typeof fetch,
        jupiterApiKey: "test-key",
      }),
    ]);

    // All should return the same result
    expect(result1.pairs).toHaveLength(1);
    expect(result2.pairs).toHaveLength(1);
    expect(result3.pairs).toHaveLength(1);

    // But Raydium API should only be called once (stampede prevented)
    expect(fetchCallCount).toBe(1);
  });
});
