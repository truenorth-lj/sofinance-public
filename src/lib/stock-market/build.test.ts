import { describe, expect, it } from "vitest";
import { buildStockMarket, displayedUnderlyings, isExcludedStockMint, parseJupiterStockRow, stockTokenRejection, type JupiterStockRow } from "./build";
import { STOCK_EXCLUDED_MINTS, STOCK_UNIVERSE, type StockUniverseRow } from "./universe";

const TSLAX = "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB";
const TSLA_BP = "TSLAqBbv4CNCnzWFeB7LmydAyEiNMJtve7DYKLpdK4S";
const TSLA_ON = "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo";
const NVDAX = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
const COINX = "Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu";

const universe: StockUniverseRow[] = [
  [COINX, "COINx", "COIN", "xstocks", "Coinbase"],
  [NVDAX, "NVDAx", "NVDA", "xstocks", "NVIDIA"],
  [TSLAX, "TSLAx", "TSLA", "xstocks", "Tesla"],
  [TSLA_BP, "TSLA", "TSLA", "backpack", "Tesla"],
  [TSLA_ON, "TSLAon", "TSLA", "ondo", "Tesla"],
];

function row(id: string, overrides: Partial<JupiterStockRow> = {}): JupiterStockRow {
  return { id, name: "Token", symbol: "T", icon: null, isVerified: true, tags: ["verified", "stocks", "xstocks"], usdPrice: 100,
    mcap: 5_000_000, liquidity: 200_000, priceChange24h: 1, volume24h: 50_000, ...overrides };
}

describe("stock universe", () => {
  it("never lists tSpaceX, BP or a pump.fun mint", () => {
    expect(STOCK_UNIVERSE.length).toBeGreaterThan(100);
    for (const [mint, symbol] of STOCK_UNIVERSE) {
      expect(isExcludedStockMint(mint), symbol).toBe(false);
      expect(symbol).not.toMatch(/^tSpaceX$|^BP$/);
    }
    expect([...STOCK_EXCLUDED_MINTS]).toHaveLength(2);
    expect(new Set(STOCK_UNIVERSE.map(([mint]) => mint)).size).toBe(STOCK_UNIVERSE.length);
  });
});

describe("parseJupiterStockRow", () => {
  it("reads price, mcap, liquidity and 24h buy + sell volume", () => {
    expect(parseJupiterStockRow({ id: TSLAX, name: "Tesla xStock", symbol: "TSLAx", isVerified: true, tags: ["stocks", 3], usdPrice: 400,
      mcap: 9e7, liquidity: 6e5, stats24h: { priceChange: -1.5, buyVolume: 7000, sellVolume: 4000 } })).toEqual({
      id: TSLAX, name: "Tesla xStock", symbol: "TSLAx", icon: null, isVerified: true, tags: ["stocks"], usdPrice: 400, mcap: 9e7,
      liquidity: 6e5, priceChange24h: -1.5, volume24h: 11_000,
    });
    expect(parseJupiterStockRow(null)).toBeNull();
    expect(parseJupiterStockRow({ symbol: "TSLAx" })).toBeNull();
  });
});

describe("stockTokenRejection", () => {
  it("applies the card filters: verified stock, mcap >= $1M, liquidity >= $50k, 24h volume >= $10k", () => {
    expect(stockTokenRejection(row(TSLAX))).toBeNull();
    expect(stockTokenRejection(undefined)).toBe("missing");
    expect(stockTokenRejection(row("Fake1111111111111111111111111111111111pump"))).toBe("excluded");
    expect(stockTokenRejection(row(TSLAX, { isVerified: false }))).toBe("unverified");
    expect(stockTokenRejection(row(TSLAX, { tags: ["verified"] }))).toBe("not_stock");
    expect(stockTokenRejection(row(TSLAX, { usdPrice: null }))).toBe("no_price");
    expect(stockTokenRejection(row(TSLAX, { mcap: 999_999 }))).toBe("mcap");
    expect(stockTokenRejection(row(TSLAX, { liquidity: 49_999 }))).toBe("liquidity");
    expect(stockTokenRejection(row(TSLAX, { volume24h: 9_999 }))).toBe("volume");
    expect(stockTokenRejection(row(TSLAX, { mcap: 1_000_000, liquidity: 50_000, volume24h: 10_000 }))).toBeNull();
  });
});

describe("buildStockMarket", () => {
  const now = new Date("2026-11-04T10:57:00Z");

  it("matches rows by exact mint only: a row with a matching symbol but another mint is ignored", () => {
    const market = buildStockMarket([row("So11111111111111111111111111111111111111112", { symbol: "TSLAx", priceChange24h: 99 })], { universe, now });
    expect(market.gainers).toEqual([]);
    expect(market.stocks).toEqual([]);
  });

  it("ranks gainers by 24h change with one row per stock (its best token)", () => {
    const market = buildStockMarket([
      row(COINX, { priceChange24h: 6.47 }), row(NVDAX, { priceChange24h: -2 }),
      row(TSLAX, { priceChange24h: 1 }), row(TSLA_BP, { priceChange24h: 3, tags: ["verified", "stocks", "backpack"] }),
    ], { universe, now });
    expect(market.gainers.map((item) => [item.underlying, item.mint])).toEqual([["COIN", COINX], ["TSLA", TSLA_BP], ["NVDA", NVDAX]]);
    expect(market.snapshotAt).toBe("2026-11-04T10:57:00.000Z");
  });

  it("sums Solana market cap per stock over passing tokens and shows the xStocks token as primary", () => {
    const market = buildStockMarket([
      row(TSLAX, { mcap: 60e6 }), row(TSLA_BP, { mcap: 20e6, tags: ["verified", "stocks", "backpack"] }),
      row(TSLA_ON, { mcap: 7e6, liquidity: 10_000, tags: ["verified", "stocks", "ondo"] }), // fails liquidity: not counted
      row(NVDAX, { mcap: 70e6 }),
    ], { universe, now });
    expect(market.stocks.map((item) => [item.underlying, item.mcapUsd, item.mint])).toEqual([["TSLA", 80e6, TSLAX], ["NVDA", 70e6, NVDAX]]);
    expect(market.tokensByUnderlying.TSLA!.map((token) => token.mint)).toEqual([TSLAX, TSLA_BP]);
  });

  it("marks a token as xStocks only when both the registry and Jupiter say so, and caps each card", () => {
    const market = buildStockMarket([row(TSLAX, { tags: ["verified", "stocks"] }), row(NVDAX), row(COINX)], { universe, now, limit: 2 });
    expect(market.tokensByUnderlying.TSLA![0]!.xstocks).toBe(false);
    expect(market.tokensByUnderlying.NVDA![0]!.xstocks).toBe(true);
    expect(market.gainers).toHaveLength(2);
    expect(displayedUnderlyings(market)).toEqual([...new Set([...market.gainers, ...market.stocks].map((item) => item.underlying))].sort());
  });
});
