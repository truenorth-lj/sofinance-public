import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UNIV4_RHC_ALLOWLISTED_POOLS } from "@sofinance/engine/protocols/uniswap-v4/constants";
import type { HomepageSolanaRow } from "@/lib/homepage-pools";
import { cardPayloadWithAprs } from "@/lib/range-apr/payload.fixture";
import type { RhcPoolSummary } from "@/lib/unified-pools/rows";

// Server HTML must carry pool names (crawlers and AI fetchers do not run the client fetch).
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/", useRouter: () => ({ push: () => {} }) }));
const mocks = vi.hoisted(() => ({ getRwaPairs: vi.fn(), getRhcPoolsSnapshot: vi.fn(), getPoolAprSnapshot: vi.fn(), getRhcAprSnapshot: vi.fn() }));
vi.mock("@/lib/rwa-store", () => ({ getRwaPairs: mocks.getRwaPairs, getPoolAprSnapshot: mocks.getPoolAprSnapshot }));
vi.mock("@/lib/rhc-snapshot", () => ({ getRhcPoolsSnapshot: mocks.getRhcPoolsSnapshot, getRhcAprSnapshot: mocks.getRhcAprSnapshot }));
// The stock cards' Jupiter read: a small fixed snapshot (no network in tests).
const STOCKS = {
  snapshotAt: "2026-10-30T11:00:00.000Z",
  gainers: [{ underlying: "MSFT", company: "Microsoft", mint: "m", symbol: "MSFTx", icon: null, priceUsd: 530.9, change24hPct: 5.28 }],
  stocks: [{ underlying: "SPCX", company: "SpaceX", mint: "s", symbol: "SPCXx", icon: null, priceUsd: 135.1, change24hPct: 0.13, mcapUsd: 89e6 }],
  buy: {},
};
vi.mock("@/lib/stock-market/homepage", () => ({ loadHomepageStocks: async () => STOCKS }));
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
  const poolsHtml = (html: string) => html.slice(html.indexOf('data-testid="top-pools"') >= 0 ? html.indexOf('data-testid="top-pools"') : html.indexOf('id="pools"'));
  const topRows = (html: string) => [...poolsHtml(html).matchAll(/<li[^>]*data-pool="([^"]+)"/g)].map((match) => match[1]);
  const topAprs = (html: string) => [...poolsHtml(html).matchAll(/data-testid="apr7d"[^>]*>([^<]+)/g)].map((match) => match[1]);
  const rhcKey = (index: number) => `robinhood:${UNIV4_RHC_ALLOWLISTED_POOLS[index]!.poolId.toLowerCase()}`;
  const fullListCount = (solana: number, hidden = 0) => solana + UNIV4_RHC_ALLOWLISTED_POOLS.length - hidden;
  const h1sOf = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((match) => (match[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
  const sectionOrder = (html: string) => (
    [
      ["landing-hero", html.indexOf('data-testid="landing-hero"')],
      ["top-pools", html.indexOf('data-testid="top-pools"')],
      ["stock-card-gainers", html.indexOf('data-testid="stock-card-gainers"')],
      ["stock-card-stocks", html.indexOf('data-testid="stock-card-stocks"')],
    ] as const
  ).filter(([, index]) => index >= 0).sort((a, b) => a[1] - b[1]).map(([name]) => name);
  const expectHero = (html: string) => {
    expect(h1sOf(html)).toEqual(["Hold the stock. Collect the fees."]);
    expect(html).toContain("Put two tokens of the same stock, like TSLAx and TSLA, in one pool. Traders swap between them, and you collect a share of the swap fees.");
    expect(html).toMatch(/href="#pools"[^>]*>See pools</);
    expect(html).toMatch(/href="\/learn\/what-is-a-same-stock-lp-pool"[^>]*>How it works</);
    expect(html).toContain('href="/docs/security"');
    expect(html).toContain("Self-custodial: we never hold your keys");
    expect(html).toContain('href="/fees"');
    expect(html).toContain("Zero performance fee");
    expect(html).toMatch(/href="\/docs"/);
    expect(html).toContain("Solana + Robinhood Chain");
    expect(sectionOrder(html)).toEqual(["landing-hero", "top-pools", "stock-card-gainers", "stock-card-stocks"]);
    expect(html).not.toContain("hero-search");
    expect(html).not.toContain('role="search"');
    expect(html).toContain('"@type":"SoftwareApplication"');
  };

  it("prerenders no top-5 rows when every 7-day APR read fails, still links See all N, and keeps JSON-LD", async () => {
    mocks.getRwaPairs.mockResolvedValue(storeResult);
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    const { default: Home, revalidate } = await import("./page");
    expect(revalidate).toBe(900);
    const html = renderToString(await Home());

    expect(mocks.getRwaPairs).toHaveBeenCalledWith({ minTvl: 0, maxPages: 10, sortBy: "estimatedFeeApr" });
    expect(mocks.getRhcPoolsSnapshot).toHaveBeenCalled();
    expect(mocks.getPoolAprSnapshot).toHaveBeenCalledTimes(storeResult.pairs.length);
    expect(mocks.getRhcAprSnapshot).toHaveBeenCalledTimes(UNIV4_RHC_ALLOWLISTED_POOLS.length);
    expect(html).not.toContain("Loading pool data");
    // No saved APR: pools with no 7-day APR are excluded from the top 5 (they still count in See all N).
    expect(topRows(html)).toEqual([]);
    expect(html).toContain("No pools to show right now.");
    expectHero(html);
    expect(html).toContain("Top pools");
    expect(html).toContain("Pools over $5k TVL, ranked by 7d estimated APR.");
    expect(html).not.toContain("All pools");
    expect(html).toContain("SpaceX");
    expect(html).toContain("Microsoft");
    expect(html).toContain("Updated 2026-10-30 11:02 UTC");
    expect(html).toContain(`See all ${fullListCount(storeResult.pairs.length)} pools →`);
    expect(html).toMatch(/<a[^>]*href="\/pools"[^>]*>See all \d+ pools →<\/a>/);
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"@type":"WebSite"');
  });

  it("prerenders the top 5 by saved 7-day APR (both chains, duplicates by APR) with the numbers in the HTML", async () => {
    mocks.getRwaPairs.mockResolvedValue({
      ...storeResult,
      pairs: [...storeResult.pairs, pool("SPCXx", "SPCX", 60_000, { poolAddress: "spcx-hot" })],
    });
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    mocks.getPoolAprSnapshot.mockImplementation(async (poolId: string) =>
      cardPayloadWithAprs(poolId === "spcx-hot" ? { micro: 40, tight: 30, standard: 5, wide: 1 } : { micro: 2, tight: 1, standard: 1, wide: 1 }));
    mocks.getRhcAprSnapshot.mockImplementation(async (poolId: string) => {
      if (poolId.toLowerCase() === UNIV4_RHC_ALLOWLISTED_POOLS[3]!.poolId.toLowerCase()) return cardPayloadWithAprs({ micro: 7.5 });
      throw new Error("not tracked");
    });
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    // spcx-hot beats the bigger spcx-pool (LJ's rule); then by APR, ties by TVL. Pools with no 7-day APR are excluded,
    // so the remaining RHC pools do not fill the last slots.
    expect(topRows(html)).toEqual(["solana:spcx-hot", rhcKey(3), "solana:usdc-usdt", "solana:mstr-pool", "solana:tsla-pool"]);
    expect(topAprs(html)).toEqual(["40.00%", "7.50%", "2.00%", "2.00%", "2.00%"]);
    const spec = UNIV4_RHC_ALLOWLISTED_POOLS[3]!;
    const robinhood = spec.currency0.symbol.endsWith("on") ? spec.currency1.symbol : spec.currency0.symbol;
    expect(html).toContain(`${robinhood}/${robinhood}on`);
    expect(html).not.toContain(`${robinhood}on/${robinhood}`);
    expect(html).toContain("Robinhood Chain");
    expect(html).toContain('data-testid="chain-badge"');
    expectHero(html);
    expect(html).toContain("Top pools");
    expect(html).toContain("Pools over $5k TVL, ranked by 7d estimated APR.");
    expect(html).not.toContain("All pools");
    // One duplicate Solana SPCX pair is hidden in the full list.
    expect(html).toContain(`See all ${fullListCount(storeResult.pairs.length + 1, 1)} pools →`);
    expect(html).toContain(`/pools?openPool=spcx-hot`);
    expect(html).toContain('data-testid="top-pools-cards"');
    expect(poolsHtml(html)).not.toContain("<table");
    expect(html).toContain("Open position");
    expect(html).toContain('"@type":"Organization"');
    expect(html).toContain('"@type":"WebSite"');
  });

  it("still prerenders the other chain when one chain's snapshot read fails", async () => {
    mocks.getRwaPairs.mockRejectedValue(new Error("store down"));
    mocks.getRhcPoolsSnapshot.mockResolvedValue(rhcResult);
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    expect(html).not.toContain("Loading pool data");
    // RHC APR reads fail in this test, so the top 5 is empty; See all still counts the RHC list.
    expect(topRows(html)).toEqual([]);
    expect(html).not.toContain("SPCXx/SPCX");
    expect(html).toContain("Updated 2026-10-30 11:02 UTC");
    expect(html).toContain(`See all ${UNIV4_RHC_ALLOWLISTED_POOLS.length} pools →`);
  });

  it("falls back to the client-loaded block when both snapshot reads fail", async () => {
    mocks.getRwaPairs.mockRejectedValue(new Error("store down"));
    mocks.getRhcPoolsSnapshot.mockRejectedValue(new Error("store down"));
    const { default: Home } = await import("./page");
    const html = renderToString(await Home());
    expect(html).toContain("Loading pool data");
  });
});
