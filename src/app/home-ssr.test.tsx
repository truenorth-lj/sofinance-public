import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { HomepageSolanaRow } from "@/lib/homepage-pools";
import { payloadWithAprs } from "@/lib/range-apr/payload.fixture";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";

// Server HTML must carry pool names (crawlers and AI fetchers do not run the client fetch).
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
const mocks = vi.hoisted(() => ({ getRwaPairs: vi.fn(), getRhcPoolsSnapshot: vi.fn(), getPoolAprSnapshot: vi.fn(), getRhcAprSnapshot: vi.fn() }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: mocks.getRwaPairs, getPoolAprSnapshot: mocks.getPoolAprSnapshot }));
vi.mock("@/lib/rhc-snapshot", () => ({ getRhcPoolsSnapshot: mocks.getRhcPoolsSnapshot, getRhcAprSnapshot: mocks.getRhcAprSnapshot }));
// Production flag values (RHC discovery and APR are code constants, on in production).
vi.mock("@/lib/protocol-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol-flags")>()),
  isRhcUniv4DiscoveryEnabled: () => true,
}));

const pool = (wrapped: string, plain: string, tvlUsd: number, extra: Record<string, unknown> = {}): HomepageSolanaRow & Record<string, unknown> => ({
  poolAddress: `${plain.toLowerCase()}-pool`,
  mintA: `${wrapped}-mint`,
  mintB: `${plain}-mint`,
  symbolA: wrapped,
  symbolB: plain,
  wrappedSymbol: wrapped,
  plainSymbol: plain,
  feeTierBps: 1,
  tvlUsd,
  volume24hUsd: 100_000,
  estimatedFeeAprPct: 87.5,
  freezeRisk: true,
  token2022A: true,
  token2022B: false,
  nameA: `${wrapped} name`,
  nameB: `${plain} name`,
  wrapKind: "suffix-x",
  jupiterTagsA: ["stocks"],
  ...extra,
});

const SNAPSHOT_AT = "2026-10-30T11:02:00.000Z";
const RHC_AT = "2026-10-30T11:02:56.939Z";
const rhcResult = {
  pools: UNIV4_RHC_ALLOWLISTED_POOLS.map((spec, i) => ({
    poolId: spec.poolId, status: "listed", tick: 0, price: null, warnings: [],
    estimatedApr: { tvlUsd: 41_000 + i * 1_000, volume24hUsd: 500, estimatedPoolFeeAprPct: 3 },
    token0: { name: spec.currency0.symbol, symbol: spec.currency0.symbol },
    token1: { name: spec.currency1.symbol, symbol: spec.currency1.symbol },
  }) as unknown as RhcPoolSummary),
  fetchedAt: RHC_AT,
  snapshot: { stale: false, snapshot: true },
};
const storeResult = {
  pairs: [
    pool("SPCXx", "SPCX", 250_000),
    pool("MSTRx", "MSTR", 120_000),
    pool("TSLAx", "TSLA", 90_000),
    pool("USDC", "USDT", 1_800_000, { poolAddress: "usdc-usdt", wrapKind: "stable", freezeRisk: false, token2022A: false }),
  ],
  fetchedAt: SNAPSHOT_AT,
  freshness: { snapshotAt: SNAPSHOT_AT, stale: false },
  tokenIcons: { solana: { "SPCXx-mint": "https://example.test/spcxx.png", "unused-mint": "https://example.test/x.png" }, robinhood: {} },
};

beforeEach(() => {
  mocks.getRwaPairs.mockReset();
  mocks.getRhcPoolsSnapshot.mockReset();
  mocks.getPoolAprSnapshot.mockReset();
  mocks.getRhcAprSnapshot.mockReset();
  mocks.getPoolAprSnapshot.mockRejectedValue(new Error("not tracked"));
  mocks.getRhcAprSnapshot.mockRejectedValue(new Error("not tracked"));
});

describe("homepage server render", () => {
  it("prerenders both chains' pools with chain tags and the saved list time, not 'Loading pool data…', and no APR number", async () => {
    mocks.getRwaPairs.mockResolvedValue(storeResult);
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    const { default: Home, revalidate } = await import("./page");
    expect(revalidate).toBe(900);
    const html = renderToString(await Home());

    expect(mocks.getRwaPairs).toHaveBeenCalledWith({ minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" });
    expect(mocks.getRhcPoolsSnapshot).toHaveBeenCalled();
    expect(html).not.toContain("Loading pool data");
    for (const name of ["SPCXx/SPCX", "MSTRx/MSTR", "TSLAx/TSLA", "SPCX/SPCXon", "NVDA/NVDAon", "GME/GMEon"]) expect(html).toContain(name);
    expect(html).toContain("$250.0k");
    expect(html).toContain('data-chain="solana"');
    expect(html).toContain('data-chain="robinhood"');
    expect(html).toContain("Robinhood Chain");
    expect(html).toContain("Uniswap v4 · dynamic fee");
    expect(html).toContain("Raydium · 1 bps");
    // Same minute on both chains: one "Updated" time, from the lists' fetchedAt.
    expect(html).toContain("Updated 2026-10-30 11:02 UTC");
    // USDC/USDT is not a same-stock pair: listed after every same-stock pool.
    const cards = html.slice(html.indexOf('data-testid="homepage-pools-cards"'), html.indexOf('data-testid="homepage-pools-table"'));
    const order = [...cards.matchAll(/data-pool="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toHaveLength(4 + UNIV4_RHC_ALLOWLISTED_POOLS.length);
    expect(order.at(-1)).toBe("usdc-usdt");
    expect(order.slice(0, 2)).toEqual(["spcx-pool", "mstr-pool"]);
    // Robinhood Chain rows open their dialog on /app/rwa-pairs.
    expect(html).toContain(`/app/rwa-pairs?openPool=${UNIV4_RHC_ALLOWLISTED_POOLS[0]!.poolId}`);
    // The range APR loads on the client; the cached HTML never states an APR figure.
    expect(html).not.toMatch(/\d+(\.\d+)?%\s*<\/span>|87\.5/);
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"@type":"WebSite"');
  });

  it("prerenders the /app/rwa-pairs pick for a duplicated pair (highest saved 7-day APR, not TVL) and the Robinhood / Ondo order", async () => {
    mocks.getRwaPairs.mockResolvedValue({
      ...storeResult,
      pairs: [...storeResult.pairs, pool("SPCXx", "SPCX", 60_000, { poolAddress: "spcx-hot" })],
    });
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    mocks.getPoolAprSnapshot.mockImplementation(async (poolId: string) =>
      payloadWithAprs(poolId === "spcx-hot" ? { micro: 40, tight: 30, standard: 5, wide: 1 } : { micro: 2, tight: 1, standard: 1, wide: 1 }));
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    // Only pools that share a pair with another pool need their APR read.
    expect(mocks.getPoolAprSnapshot.mock.calls.map(([id]) => id).sort()).toEqual(["spcx-hot", "spcx-pool"]);
    expect(mocks.getRhcAprSnapshot).not.toHaveBeenCalled();
    const cards = html.slice(html.indexOf('data-testid="homepage-pools-cards"'), html.indexOf('data-testid="homepage-pools-table"'));
    const order = [...cards.matchAll(/data-pool="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toContain("spcx-hot");
    expect(order).not.toContain("spcx-pool");
    for (const name of ["MSTR/MSTRon", "AAPL/AAPLon", "TSLA/TSLAon"]) expect(html).toContain(name);
    expect(html).not.toContain("MSTRon/MSTR");
    // Still no APR figure in the cached HTML.
    expect(html).not.toMatch(/\d+(\.\d+)?%\s*<\/span>/);
  });

  it("still prerenders the other chain when one chain's snapshot read fails", async () => {
    mocks.getRwaPairs.mockRejectedValue(new Error("store down"));
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    expect(html).not.toContain("Loading pool data");
    expect(html).toContain("SPCX/SPCXon");
    expect(html).not.toContain("SPCXx/SPCX");
    expect(html).toContain("Updated 2026-10-30 11:02 UTC");
  });

  it("falls back to the client-loaded table when both snapshot reads fail", async () => {
    mocks.getRwaPairs.mockRejectedValue(new Error("store down"));
    mocks.getRhcPoolsSnapshot.mockRejectedValue(new Error("store down"));
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    expect(html).toContain("Loading pool data");
  });
});
