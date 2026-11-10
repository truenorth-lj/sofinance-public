import { describe, expect, it } from "vitest";
import type { StockPerformance } from "./position-performance-report";
import { groupByStock, portfolioTotals } from "./stock-portfolio";

const stock = (overrides: Partial<StockPerformance>): StockPerformance => ({
  symbol: "NVDA", priceMint: "m", priceUsd: 100, change24hPct: 0, sharesNow: 1, valueUsd: 100, sharesIn: 1,
  firstDepositAtIso: "2026-10-20T00:00:00.000Z", entryPriceUsd: 100, priceChangeUsd: 0, priceChangePct: 0,
  feeShares: 0, feeUsd: 0, totalUsd: 0, sparkline24h: [], sparklineSinceEntry: [], entryPriceSource: null, entryUnavailableReason: null,
  ...overrides,
});

describe("groupByStock", () => {
  it("merges positions of the same stock: shares and USD add up, entry price averages by shares put in", () => {
    const rows = groupByStock([
      { key: "a", stock: stock({ symbol: "AAPL", sharesIn: 1, entryPriceUsd: 260, priceUsd: 268.9, valueUsd: 269.7, sharesNow: 1.003,
        priceChangeUsd: 8.9, feeShares: 0.003, feeUsd: 0.8, firstDepositAtIso: "2026-10-10T00:00:00.000Z", sparklineSinceEntry: [1, 2] }) },
      { key: "b", stock: stock({ symbol: "NVDA" }) },
      { key: "c", stock: stock({ symbol: "AAPL", sharesIn: 2, entryPriceUsd: 268.3, priceUsd: 268.9, valueUsd: 539.2, sharesNow: 2.005,
        priceChangeUsd: 1.2, feeShares: 0.005, feeUsd: 1.35, firstDepositAtIso: "2026-10-25T00:00:00.000Z", sparklineSinceEntry: [3, 4] }) },
    ]);
    expect(rows.map((row) => row.symbol)).toEqual(["AAPL", "NVDA"]);
    const aapl = rows[0]!;
    expect(aapl.positionKeys).toEqual(["a", "c"]);
    expect(aapl.sharesIn).toBe(3);
    expect(aapl.entryPriceUsd).toBeCloseTo((260 + 2 * 268.3) / 3, 10);
    expect(aapl.priceChangeUsd).toBeCloseTo(10.1, 10);
    expect(aapl.priceChangePct).toBeCloseTo(10.1 / (260 + 2 * 268.3) * 100, 10);
    expect(aapl.feeShares).toBeCloseTo(0.008, 10);
    expect(aapl.feeUsd).toBeCloseTo(2.15, 10);
    expect(aapl.totalUsd).toBeCloseTo(12.25, 10);
    expect(aapl.firstDepositAtIso).toBe("2026-10-10T00:00:00.000Z");
    expect(aapl.sparklineSinceEntry).toEqual([1, 2]);
  });

  it("does not add up a sum with an unknown part", () => {
    const [row] = groupByStock([{ key: "a", stock: stock({}) }, { key: "b", stock: stock({ priceChangeUsd: null, entryPriceUsd: null, entryUnavailableReason: "x" }) }]);
    expect(row!.priceChangeUsd).toBeNull();
    expect(row!.totalUsd).toBeNull();
    expect(row!.entryUnavailableReason).toBe("x");
  });
});

describe("portfolioTotals", () => {
  it("adds USD across stocks and turns each stock's 24h % into the value it moved", () => {
    const rows = groupByStock([
      { key: "a", stock: stock({ symbol: "NVDA", valueUsd: 446.38, change24hPct: -6.08, priceChangeUsd: -27.13, sharesIn: 2.5, entryPriceUsd: 187.2, feeUsd: 5.5 }) },
      { key: "b", stock: stock({ symbol: "TSLA", valueUsd: 497.61, change24hPct: 1.24, priceChangeUsd: 18.37, sharesIn: 1.2, entryPriceUsd: 396.79, feeUsd: 3.09 }) },
    ]);
    const totals = portfolioTotals(rows);
    const move = (value: number, pct: number) => value * pct / (100 + pct);
    const change = move(446.38, -6.08) + move(497.61, 1.24);
    expect(totals.stocks).toBe(2);
    expect(totals.valueUsd).toBeCloseTo(943.99, 10);
    expect(totals.change24hUsd).toBeCloseTo(change, 10);
    expect(totals.change24hPct).toBeCloseTo(change / (943.99 - change) * 100, 10);
    expect(totals.priceChangeUsd).toBeCloseTo(-8.76, 10);
    expect(totals.costUsd).toBeCloseTo(2.5 * 187.2 + 1.2 * 396.79, 10);
    expect(totals.feeUsd).toBeCloseTo(8.59, 10);
    expect(totals.totalUsd).toBeCloseTo(-0.17, 10);
  });

  it("recovers the totals once the missing stock has an entry price (the SPCX / SNDK case)", () => {
    const sndk = stock({ symbol: "SNDK", valueUsd: 1116.62, priceChangeUsd: -162.36, sharesIn: 1, entryPriceUsd: 1278.98, feeUsd: 2.1 });
    const spcxMissing = stock({ symbol: "SPCX", valueUsd: 489.07, sharesIn: 3.4488, entryPriceUsd: null, priceChangeUsd: null,
      feeUsd: 1.03, entryUnavailableReason: "Entry price was not recorded for this position." });
    const before = portfolioTotals(groupByStock([{ key: "sndk", stock: sndk }, { key: "spcx", stock: spcxMissing }]));
    expect(before.priceChangeUsd).toBeNull();
    expect(before.totalUsd).toBeNull();
    const spcxPriced = stock({ symbol: "SPCX", valueUsd: 489.07, sharesIn: 3.4488, entryPriceUsd: 136.81,
      priceChangeUsd: 3.4488 * (141.6 - 136.81), feeUsd: 1.03, entryUnavailableReason: null });
    const after = portfolioTotals(groupByStock([{ key: "sndk", stock: sndk }, { key: "spcx", stock: spcxPriced }]));
    expect(after.priceChangeUsd).toBeCloseTo(-162.36 + 3.4488 * (141.6 - 136.81), 6);
    expect(after.totalUsd).toBeCloseTo(after.priceChangeUsd! + 2.1 + 1.03, 6);
    expect(after.costUsd).toBeCloseTo(1 * 1278.98 + 3.4488 * 136.81, 6);
  });
});
