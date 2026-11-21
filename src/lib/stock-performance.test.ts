import { describe, expect, it } from "vitest";
import { computeStockPerformance, dailyCloseAt, downsample, type StockPerformanceInput } from "./stock-performance";
const input = (overrides: Partial<StockPerformanceInput> = {}): StockPerformanceInput => ({
  history: [{ blockTime: 1_800_000_000, events: [{ kind: "open", poolState: "pool", nftOwner: "owner",
    tickLower: -1, tickUpper: 1, liquidity: "1", amountA: "1", amountB: "0" }] }],
  positionId: "position", poolId: "pool", decimalsA: 6, decimalsB: 6,
  tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 2, metrics: { equity: 0.401697, feesEarned: 0.0189176 } },
  incomplete: false, quote: { mint: "plain", priceChange24hPct: -2 }, basePricing: { usdPerRawUnit: 900, multiplier: 1 },
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
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.totalUsd).toBeNull();
  });
  it("keeps a recorded entry price when history is incomplete", () => {
    const stock = computeStockPerformance(input({
      incomplete: true,
      entry: { sharesIn: 0.38, entryPriceUsd: 1278.93, source: "stored", reason: null },
      valuation: { valueUsd: 333.79, feeUsd: 16.9 },
    }));
    expect(stock.entryPriceUsd).toBe(1278.93);
    expect(stock.sharesIn).toBe(0.38);
    expect(stock.entryPriceSource).toBe("stored");
    expect(stock.entryUnavailableReason).toBeNull();
    expect(stock.priceChangeUsd).toBeCloseTo(0.38 * (900 - 1278.93), 9);
    expect(stock.priceChangePct).toBeCloseTo((900 / 1278.93 - 1) * 100, 9);
    expect(stock.feeUsd).toBe(16.9);
    expect(stock.totalUsd).toBeCloseTo(stock.priceChangeUsd! + 16.9, 9);
  });
  it("does not keep a recorded entry price when incomplete history has no opening event", () => {
    const stock = computeStockPerformance(input({
      incomplete: true,
      history: [{ blockTime: 1_800_000_000, events: [{ kind: "increase", positionNftMint: "position",
        liquidity: "1", amountA: "1", amountB: "0" }] }],
      entry: { sharesIn: 0.38, entryPriceUsd: 1278.93, source: "stored", reason: null },
      valuation: { valueUsd: 333.79, feeUsd: 16.9 },
    }));
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.sharesIn).toBeNull();
    expect(stock.entryUnavailableReason).toMatch(/incomplete/);
    expect(stock.totalUsd).toBeNull();
  });
  it("does not treat an unpriced entry as recorded when history is incomplete", () => {
    const stock = computeStockPerformance(input({
      incomplete: true,
      entry: { sharesIn: 0.38, entryPriceUsd: null, source: null, reason: "Entry price is still being recorded; it appears on a later view." },
    }));
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.sharesIn).toBeNull();
    expect(stock.entryUnavailableReason).toMatch(/incomplete/);
  });
  it("does not invent a deposit date or a quote", () => {
    const stock = computeStockPerformance(input({ history: [], quote: null, basePricing: { usdPerRawUnit: null, multiplier: 1 } }));
    expect(stock.firstDepositAtIso).toBeNull();
    expect(stock.priceUsd).toBeNull();
    expect(stock.change24hPct).toBeNull();
  });
});
describe("share units (X3-6)", () => {
  // SNDK: a deposit recorded before SNDKx's multiplier went 1 → 8 (11/20 17:30 Taipei). The reference-pool trades price a
  // raw token unit (~$630 then, ~$629 now); Jupiter prices a share ($78.63) and the registry applies ×8 (design §0).
  const sndk = (overrides: Partial<StockPerformanceInput> = {}) => input({
    tokenEquivalent: { baseSymbol: "SNDK", baseSide: "A", uiPriceBPerA: 1, metrics: { equity: 2.5, feesEarned: 0.02 } },
    basePricing: { usdPerRawUnit: 78.63 * 8, multiplier: 8 },
    entry: { sharesIn: 2.4, entryPriceUsd: 630.67, source: "stored", reason: null },
    valuation: { valueUsd: 1572.6, feeUsd: 12.58 },
    ...overrides,
  });
  it("compares the entry with today's price in one unit: no fake −88% after a split", () => {
    const stock = computeStockPerformance(sndk());
    expect(stock.priceChangePct).toBeCloseTo((78.63 * 8 / 630.67 - 1) * 100, 9);
    expect(stock.priceChangePct!).toBeGreaterThan(-1);
    expect(stock.priceChangeUsd).toBeCloseTo(2.4 * (78.63 * 8 - 630.67), 9);
    expect(stock.totalUsd).toBeCloseTo(stock.priceChangeUsd! + 12.58, 9);
  });
  it("shows per-share figures at the multiplier now: price, split-adjusted entry, and shares", () => {
    const stock = computeStockPerformance(sndk());
    expect(stock.priceUsd).toBeCloseTo(78.63, 9);
    expect(stock.entryPriceUsd).toBeCloseTo(630.67 / 8, 9);
    expect(stock.sharesNow).toBeCloseTo(2.5 * 8, 9);
    expect(stock.sharesIn).toBeCloseTo(2.4 * 8, 9);
    expect(stock.feeShares).toBeCloseTo(0.02 * 8, 9);
    // The shown figures multiply out: shares in × (price − entry) is the raw-unit price change.
    expect(stock.sharesIn! * (stock.priceUsd! - stock.entryPriceUsd!)).toBeCloseTo(stock.priceChangeUsd!, 9);
    expect(stock.entryPriceSource).toBe("stored; per share at today's ×8 multiplier");
  });
  it("counts a dividend multiplier step as return (the token holder's real change)", () => {
    // NVDAx-like ×1.001701: the share price is flat, the raw unit is worth 0.17% more.
    const stock = computeStockPerformance(input({ basePricing: { usdPerRawUnit: 180 * 1.001701, multiplier: 1.001701 },
      entry: { sharesIn: 1, entryPriceUsd: 180, source: "stored", reason: null } }));
    expect(stock.priceUsd).toBeCloseTo(180, 9);
    expect(stock.priceChangePct).toBeCloseTo(0.1701, 9);
    expect(stock.entryPriceSource).toBe("stored; per share at today's ×1.0017 multiplier");
  });
  it("keeps the source text unchanged at multiplier 1", () => {
    const stock = computeStockPerformance(input({ entry: { sharesIn: 1, entryPriceUsd: 800, source: "stored", reason: null } }));
    expect(stock.entryPriceUsd).toBe(800);
    expect(stock.priceUsd).toBe(900);
    expect(stock.entryPriceSource).toBe("stored");
  });
  it("an unpriced base side leaves the price and price change unknown, never zero", () => {
    const stock = computeStockPerformance(sndk({ basePricing: { usdPerRawUnit: null, multiplier: 8 } }));
    expect(stock.priceUsd).toBeNull();
    expect(stock.priceChangeUsd).toBeNull();
    expect(stock.priceChangePct).toBeNull();
    expect(stock.totalUsd).toBeNull();
    expect(stock.entryPriceUsd).toBeCloseTo(630.67 / 8, 9);
    expect(stock.sharesNow).toBeCloseTo(20, 9);
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
