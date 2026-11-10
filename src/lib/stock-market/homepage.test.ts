import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const loadStockMarket = vi.fn();
const loadStockBuyEligibility = vi.fn();
vi.mock("./source", () => ({ loadStockMarket: () => loadStockMarket(), loadStockBuyEligibility: (market: unknown) => loadStockBuyEligibility(market) }));

const { loadHomepageStocks } = await import("./homepage");
const market = { snapshotAt: "2026-11-04T12:00:00.000Z", gainers: [], stocks: [], tokensByUnderlying: {} };
const option = { underlying: "TSLA", company: "Tesla", mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB", mintShort: "XsDo…oB", issuerName: "xStocks", symbol: "TSLAx" };

beforeEach(() => { loadStockMarket.mockReset(); loadStockBuyEligibility.mockReset(); });

describe("loadHomepageStocks", () => {
  it("returns the cards with Buy options", async () => {
    loadStockMarket.mockImplementation(async () => market);
    loadStockBuyEligibility.mockImplementation(async () => ({ options: { TSLA: option }, candidates: {}, unsupported: {} }));
    await expect(loadHomepageStocks()).resolves.toEqual({ snapshotAt: market.snapshotAt, gainers: [], stocks: [], buy: { TSLA: option } });
  });

  it("shows only stocks that can be bought, five per card, in rank order; unsupported ones are never listed", async () => {
    const ranked = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"].map((underlying, index) => ({ underlying, company: underlying, mint: `M${index}`,
      symbol: `${underlying}x`, icon: null, priceUsd: 1, change24hPct: 7 - index, mcapUsd: 1e9 - index }));
    loadStockMarket.mockImplementation(async () => ({ ...market, gainers: ranked, stocks: [...ranked].reverse() }));
    const options = Object.fromEntries(["BBB", "CCC", "DDD", "FFF", "GGG"].map((underlying) => [underlying, { ...option, underlying }]));
    loadStockBuyEligibility.mockImplementation(async () => ({ options, candidates: {}, unsupported: { AAA: "multiplier", EEE: "no route" } }));
    const stocks = await loadHomepageStocks();
    expect(stocks!.gainers.map((row) => row.underlying)).toEqual(["BBB", "CCC", "DDD", "FFF", "GGG"]);
    expect(stocks!.stocks.map((row) => row.underlying)).toEqual(["GGG", "FFF", "DDD", "CCC", "BBB"]);
    expect(stocks).not.toHaveProperty("unsupported");
  });

  it("when eligibility failed, shows the first five of each ranking without Buy (nothing is hidden)", async () => {
    const ranked = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"].map((underlying) => ({ underlying, company: underlying, mint: underlying, symbol: underlying,
      icon: null, priceUsd: 1, change24hPct: 1, mcapUsd: 1e9 }));
    loadStockMarket.mockImplementation(async () => ({ ...market, gainers: ranked, stocks: ranked }));
    loadStockBuyEligibility.mockImplementation(async () => { throw new Error("rpc down"); });
    const stocks = await loadHomepageStocks();
    expect(stocks!.gainers.map((row) => row.underlying)).toEqual(["AAA", "BBB", "CCC", "DDD", "EEE"]);
    expect(stocks!.buy).toEqual({});
  });

  it("null when the market read fails (the client loads the cards later)", async () => {
    loadStockMarket.mockImplementation(async () => { throw new Error("Jupiter HTTP 429"); });
    await expect(loadHomepageStocks()).resolves.toBeNull();
  });

  it("fails closed: an eligibility error or timeout keeps the cards but shows no Buy", async () => {
    loadStockMarket.mockImplementation(async () => market);
    loadStockBuyEligibility.mockImplementation(async () => { throw new Error("rpc down"); });
    await expect(loadHomepageStocks()).resolves.toMatchObject({ buy: {} });
    loadStockBuyEligibility.mockImplementation(() => new Promise(() => undefined));
    await expect(loadHomepageStocks(1_000, 20)).resolves.toMatchObject({ buy: {} });
  });
});
