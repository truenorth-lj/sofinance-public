import { describe, expect, it } from "vitest";
import { computeStockPerformance, dailyCloseAt, downsample, type StockPerformanceInput } from "./stock-performance";
const input = (overrides: Partial<StockPerformanceInput> = {}): StockPerformanceInput => ({
  history: [{ blockTime: 1_800_000_000, events: [{ kind: "open", poolState: "pool", nftOwner: "owner",
    tickLower: -1, tickUpper: 1, liquidity: "1", amountA: "1", amountB: "0" }] }],
  positionId: "position", poolId: "pool", decimalsA: 6, decimalsB: 6,
  tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 2, metrics: { equity: 0.401697, feesEarned: 0.0189176 } },
  incomplete: false, quote: { mint: "plain", usdPrice: 900, priceChange24hPct: -2 },
  daily: null, hourly: null, historySource: null, nowSeconds: 1_800_000_001, ...overrides,
});
describe("existing-metric stock presentation", () => {
  it("preserves token-equivalent position and cumulative fee amounts", () => {
    const stock = computeStockPerformance(input());
    expect(stock.sharesNow).toBe(0.401697);
    expect(stock.feeShares).toBe(0.0189176);
    expect(stock.priceUsd).toBe(900);
    expect(stock.change24hPct).toBe(-2);
    expect(stock.firstDepositAtIso).toBe(new Date(1_800_000_000_000).toISOString());
  });
  it("does not recompute existing USD valuations from one mint", () => {
    const stock = computeStockPerformance(input());
    expect(stock.valueUsd).toBeNull();
    expect(stock.feeUsd).toBeNull();
  });
  it("keeps unknown entry cost, price movement and total unknown rather than zero", () => {
    const stock = computeStockPerformance(input());
    expect(stock.sharesIn).toBeNull();
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.priceChangeUsd).toBeNull();
    expect(stock.priceChangePct).toBeNull();
    expect(stock.totalUsd).toBeNull();
    expect(stock.entryPriceSource).toBeNull();
    expect(stock.entryUnavailableReason).toMatch(/not recorded/);
  });
  it("does not substitute historical candle closes for recorded entry prices", () => {
    const stock = computeStockPerformance(input({ daily: [{ time: 1_799_971_200, close: 800 }], hourly: [{ time: 1_800_000_000, close: 890 }] }));
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.sparkline24h).toEqual([]);
    expect(stock.sparklineSinceEntry).toEqual([]);
  });
  it("retains known current amounts when history is incomplete", () => {
    const stock = computeStockPerformance(input({ incomplete: true }));
    expect(stock.entryUnavailableReason).toMatch(/incomplete/);
    expect(stock.sharesNow).toBe(0.401697);
    expect(stock.totalUsd).toBeNull();
  });
  it("does not invent a deposit date or a quote", () => {
    const stock = computeStockPerformance(input({ history: [], quote: null }));
    expect(stock.firstDepositAtIso).toBeNull();
    expect(stock.priceUsd).toBeNull();
    expect(stock.change24hPct).toBeNull();
  });
});
// The old isolated candle utility remains testable but is not on the view's read path.
describe("legacy candle utilities", () => {
  it("limits the daily-candle fallback to three days", () => {
    expect(dailyCloseAt([{ time: 4 * 86_400, close: 100 }], 86_400)).toBe(100);
    expect(dailyCloseAt([{ time: 4 * 86_400, close: 100 }], 0)).toBeNull();
  });
  it("bounds a series while preserving endpoints", () => {
    const values = Array.from({ length: 200 }, (_, index) => index);
    const out = downsample(values, 60);
    expect(out).toHaveLength(60);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(199);
  });
});
