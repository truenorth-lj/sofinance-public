import { describe, expect, it } from "vitest";
import { computeStockPerformance, dailyCloseAt, downsample, type StockPerformanceInput } from "./stock-performance";
import type { PositionCashflowEvent } from "./position-performance-events";

const POOL = "pool1111111111111111111111111111";
const POSITION = "pos11111111111111111111111111111";
const DAY = 86_400;
const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / 1000;

const open = (a: number, b: number): PositionCashflowEvent => ({
  kind: "open", poolState: POOL, nftOwner: "owner", tickLower: -10, tickUpper: 10, liquidity: "1", amountA: String(a), amountB: String(b),
});
const increase = (a: number, b: number): PositionCashflowEvent => ({ kind: "increase", positionNftMint: POSITION, liquidity: "1", amountA: String(a), amountB: String(b) });
const decrease = (a: number, b: number, feeA = 0, feeB = 0): PositionCashflowEvent => ({
  kind: "decrease", positionNftMint: POSITION, liquidity: "1", principalA: String(a), principalB: String(b), feeA: String(feeA), feeB: String(feeB),
});

function input(overrides: Partial<StockPerformanceInput> = {}): StockPerformanceInput {
  return {
    history: [{ blockTime: day("2026-10-20") + 3600, events: [open(1, 1)] }],
    positionId: POSITION,
    poolId: POOL,
    decimalsA: 0,
    decimalsB: 0,
    // uiPriceBPerA = 1: one A token and one B token are one share each.
    tokenEquivalent: { baseSymbol: "NVDA", baseSide: "A", uiPriceBPerA: 1, metrics: { equity: 2.0312, feesEarned: 0.0312 } },
    incomplete: false,
    quote: { mint: "NVDAx", usdPrice: 176.35, priceChange24hPct: -6.08 },
    daily: [{ time: day("2026-10-19"), close: 190 }, { time: day("2026-10-20"), close: 187.2 }, { time: day("2026-11-09"), close: 176.35 }],
    hourly: [{ time: day("2026-11-09") - 2 * DAY, close: 1 }, { time: day("2026-11-09"), close: 180 }, { time: day("2026-11-09") + 3600, close: 176.35 }],
    historySource: "GeckoTerminal daily close, NVDAx / USDC pool",
    nowSeconds: day("2026-11-09") + 7200,
    ...overrides,
  };
}

describe("computeStockPerformance", () => {
  it("prices the shares put in at the deposit day's close and the fees at today's price", () => {
    const stock = computeStockPerformance(input());
    expect(stock.symbol).toBe("NVDA");
    expect(stock.sharesIn).toBe(2);
    expect(stock.entryPriceUsd).toBe(187.2);
    expect(stock.priceChangeUsd).toBeCloseTo(2 * (176.35 - 187.2), 10);
    expect(stock.priceChangePct).toBeCloseTo((176.35 / 187.2 - 1) * 100, 10);
    expect(stock.feeShares).toBe(0.0312);
    expect(stock.feeUsd).toBeCloseTo(0.0312 * 176.35, 10);
    expect(stock.totalUsd).toBeCloseTo(stock.priceChangeUsd! + stock.feeUsd!, 10);
    expect(stock.valueUsd).toBeCloseTo(2.0312 * 176.35, 10);
    expect(stock.change24hPct).toBe(-6.08);
    expect(stock.firstDepositAtIso).toBe("2026-10-20T01:00:00.000Z");
    expect(stock.entryUnavailableReason).toBeNull();
  });

  it("averages several deposits by shares and keeps only the principal still in the position", () => {
    const stock = computeStockPerformance(input({
      history: [
        { blockTime: day("2026-10-01"), events: [open(1, 0)] },
        { blockTime: day("2026-10-02") + 10, events: [increase(2, 1)] },
        { blockTime: day("2026-10-03"), events: [decrease(1, 0, 5, 5)] },
      ],
      daily: [{ time: day("2026-10-01"), close: 100 }, { time: day("2026-10-02"), close: 120 }],
      quote: { mint: "NVDAx", usdPrice: 130, priceChange24hPct: 1 },
    }));
    expect(stock.entryPriceUsd).toBe((1 * 100 + 3 * 120) / 4);
    expect(stock.sharesIn).toBe(3);
    expect(stock.priceChangeUsd).toBeCloseTo(3 * (130 - 115), 10);
  });

  it("converts the other token with the current-tick rate", () => {
    const stock = computeStockPerformance(input({
      tokenEquivalent: { baseSymbol: "NVDA", baseSide: "A", uiPriceBPerA: 2, metrics: { equity: 1.5, feesEarned: 0 } },
    }));
    // 1 A + 1 B at 2 B per A = 1.5 shares of A.
    expect(stock.sharesIn).toBe(1.5);
  });

  it("leaves the entry price out, with the reason, when the history is incomplete", () => {
    const stock = computeStockPerformance(input({ incomplete: true }));
    expect(stock.sharesIn).toBeNull();
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.priceChangeUsd).toBeNull();
    expect(stock.totalUsd).toBeNull();
    expect(stock.entryUnavailableReason).toMatch(/incomplete/);
    expect(stock.feeUsd).toBeCloseTo(0.0312 * 176.35, 10);
  });

  it("says past prices are unavailable when there are no daily closes", () => {
    const stock = computeStockPerformance(input({ daily: null }));
    expect(stock.sharesIn).toBe(2);
    expect(stock.entryPriceUsd).toBeNull();
    expect(stock.entryUnavailableReason).toMatch(/Past prices/);
    expect(stock.sparklineSinceEntry).toEqual([]);
  });

  it("has no USD numbers without a current price", () => {
    const stock = computeStockPerformance(input({ quote: null }));
    expect(stock.priceUsd).toBeNull();
    expect(stock.valueUsd).toBeNull();
    expect(stock.feeUsd).toBeNull();
    expect(stock.priceChangeUsd).toBeNull();
  });

  it("draws the since-entry line from the first deposit day and the 24h line from the last day, both ending at the live price", () => {
    const stock = computeStockPerformance(input({ quote: { mint: "NVDAx", usdPrice: 175.9, priceChange24hPct: -6.3 } }));
    expect(stock.sparklineSinceEntry).toEqual([187.2, 176.35, 175.9]);
    expect(stock.sparkline24h).toEqual([180, 176.35, 175.9]);
  });
});

describe("dailyCloseAt", () => {
  const daily = [{ time: day("2026-10-01"), close: 100 }, { time: day("2026-10-04"), close: 110 }];
  it("uses the candle of the deposit's UTC day", () => expect(dailyCloseAt(daily, day("2026-10-01") + 80_000)).toBe(100));
  it("falls forward to the next candle within three days", () => expect(dailyCloseAt(daily, day("2026-10-02"))).toBe(110));
  it("gives up past that", () => expect(dailyCloseAt(daily, day("2026-09-20"))).toBeNull());
});

describe("downsample", () => {
  it("keeps the first and last point and at most the limit", () => {
    const values = Array.from({ length: 200 }, (_, i) => i);
    const out = downsample(values, 60);
    expect(out).toHaveLength(60);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(199);
  });
});
