import { describe, expect, it } from "vitest";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { portfolioTotals, positionFigures, type FiguresState } from "./figures";

const report = (metrics: Partial<PositionPerformanceReport["metrics"]>, stock?: Partial<NonNullable<PositionPerformanceReport["stock"]>>) =>
  ({ metrics: { currentEquityUsd: null, uncollectedFeesUsd: null, feesEarnedUsd: null, ...metrics },
    stock: stock ? { symbol: "TSLA", sharesNow: 0, valueUsd: null, feeUsd: null, ...stock } : null }) as unknown as PositionPerformanceReport;
const ready = (valueUsd: number | null, unclaimedFeesUsd: number | null, cumulativeFeesUsd: number | null): FiguresState =>
  ({ status: "ready", figures: { stock: null, shares: null, valueUsd, unclaimedFeesUsd, cumulativeFeesUsd } });

describe("positionFigures", () => {
  it("reads the stock view first, then the report metrics", () => {
    expect(positionFigures(report({ currentEquityUsd: 10, uncollectedFeesUsd: 1, feesEarnedUsd: 4 }, { sharesNow: 2.5, valueUsd: 12 })))
      .toEqual({ stock: "TSLA", shares: 2.5, valueUsd: 12, unclaimedFeesUsd: 1, cumulativeFeesUsd: 4 });
    expect(positionFigures(report({ currentEquityUsd: 10, uncollectedFeesUsd: 1, feesEarnedUsd: null }, { sharesNow: 2.5, feeUsd: 3 })))
      .toMatchObject({ valueUsd: 10, cumulativeFeesUsd: 3 });
  });
  it("is all dashes without a report, never zero", () => {
    expect(positionFigures(null)).toEqual({ stock: null, shares: null, valueUsd: null, unclaimedFeesUsd: null, cumulativeFeesUsd: null });
    expect(positionFigures(report({ currentEquityUsd: Number.NaN }))).toMatchObject({ valueUsd: null });
  });
});

describe("portfolioTotals", () => {
  it("adds every read position and an extra chain's value", () => {
    expect(portfolioTotals([ready(100, 2, 10), ready(50, 1, 5)], [25])).toEqual({ positions: 3, valueUsd: 175, unclaimedFeesUsd: 3,
      cumulativeFeesUsd: 15, pending: 0, missing: 0 });
  });
  it("adds up progressively while positions are still loading, and says how many are pending", () => {
    expect(portfolioTotals([ready(100, 2, 10), { status: "loading" }], [25])).toMatchObject({ positions: 3, valueUsd: 125, unclaimedFeesUsd: 2,
      cumulativeFeesUsd: 10, pending: 1, missing: 0 });
    expect(portfolioTotals([{ status: "loading" }, { status: "loading" }])).toMatchObject({ valueUsd: null, unclaimedFeesUsd: null, pending: 2 });
  });
  it("counts failed or unpriced positions as missing instead of zero", () => {
    expect(portfolioTotals([ready(100, 2, 10), { status: "failed" }], [null])).toMatchObject({ valueUsd: 100, missing: 2 });
    expect(portfolioTotals([{ status: "failed" }])).toMatchObject({ valueUsd: null, unclaimedFeesUsd: null, missing: 1 });
    expect(portfolioTotals([])).toMatchObject({ positions: 0, valueUsd: null });
  });
});
