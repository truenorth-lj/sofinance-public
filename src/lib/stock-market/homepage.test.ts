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
    await expect(loadHomepageStocks()).resolves.toEqual({ snapshotAt: market.snapshotAt, gainers: [], stocks: [], buy: { TSLA: option }, unsupported: {} });
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
