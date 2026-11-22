import { describe, expect, it } from "vitest";
import type { PositionPerformanceReport } from "@/lib/position-performance-report";
import { cumulativeFeesUpdating, portfolioTotals, positionFigures, type FiguresState } from "./figures";

const report = (metrics: Partial<PositionPerformanceReport["metrics"]>, stock?: Partial<NonNullable<PositionPerformanceReport["stock"]>>) =>
  ({ metrics: { currentEquityUsd: null, uncollectedFeesUsd: null, feesEarnedUsd: null, ...metrics },
    stock: stock ? { symbol: "TSLA", sharesNow: 0, valueUsd: null, feeUsd: null, ...stock } : null }) as unknown as PositionPerformanceReport;
const ready = (valueUsd: number | null, unclaimedFeesUsd: number | null, cumulativeFeesUsd: number | null,
  extra: Partial<Extract<FiguresState, { status: "ready" }>> = {}): FiguresState =>
  ({ status: "ready", figures: { stock: null, shares: null, valueUsd, unclaimedFeesUsd, cumulativeFeesUsd }, ...extra });

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
      cumulativeFeesUsd: 15, pending: 0, missing: 0, cumulativePending: 0 });
  });
  it("adds up progressively while positions are still loading, and says how many are pending", () => {
    expect(portfolioTotals([ready(100, 2, 10), { status: "loading" }], [25])).toMatchObject({ positions: 3, valueUsd: 125, unclaimedFeesUsd: 2,
      cumulativeFeesUsd: 10, pending: 1, missing: 0 });
    expect(portfolioTotals([{ status: "loading" }, { status: "loading" }])).toMatchObject({ valueUsd: null, unclaimedFeesUsd: null, pending: 2 });
  });
  it("does not count a catching-up cumulative-fee dash as missing, and reports it as cumulativePending", () => {
    expect(portfolioTotals([ready(100, 2, null, { historyStatus: "updating" })])).toMatchObject({
      valueUsd: 100, unclaimedFeesUsd: 2, cumulativeFeesUsd: null, missing: 0, cumulativePending: 1 });
    expect(portfolioTotals([ready(100, 2, null, { historyStatus: "stale" })])).toMatchObject({ missing: 0, cumulativePending: 1 });
    expect(portfolioTotals([ready(100, 2, null, { historyStatus: "unavailable" })])).toMatchObject({ missing: 0, cumulativePending: 1 });
  });
  it("still counts a cumulative-fee null as missing when history is fresh or has no catching-up status", () => {
    expect(portfolioTotals([ready(100, 2, null)])).toMatchObject({ valueUsd: 100, unclaimedFeesUsd: 2, cumulativeFeesUsd: null, missing: 1, cumulativePending: 0 });
    expect(portfolioTotals([ready(100, 2, null, { historyStatus: "fresh" })])).toMatchObject({ missing: 1, cumulativePending: 0 });
  });
  it("includes a retained last complete value in the total and does not count it as pending or missing", () => {
    expect(portfolioTotals([ready(100, 2, 11.36, { historyStatus: "updating", retained: true })])).toMatchObject({
      cumulativeFeesUsd: 11.36, missing: 0, cumulativePending: 0 });
  });
  it("can include a retained value while excluding another catching-up position that never had one", () => {
    expect(portfolioTotals([
      ready(100, 2, 11.36, { historyStatus: "updating", retained: true }),
      ready(80, 0, null, { historyStatus: "updating" }),
    ])).toMatchObject({ valueUsd: 180, cumulativeFeesUsd: 11.36, missing: 0, cumulativePending: 1 });
  });
  it("counts failed or unpriced positions as missing instead of zero", () => {
    expect(portfolioTotals([ready(100, 2, 10), { status: "failed" }], [null])).toMatchObject({ valueUsd: 100, missing: 2 });
    expect(portfolioTotals([{ status: "failed" }])).toMatchObject({ valueUsd: null, unclaimedFeesUsd: null, missing: 1 });
    expect(portfolioTotals([])).toMatchObject({ positions: 0, valueUsd: null });
  });
});

describe("cumulativeFeesUpdating (row hint)", () => {
  it("labels a retained value and a catching-up dash; not a fresh dash, a value, a failure or a loading row", () => {
    expect(cumulativeFeesUpdating(ready(100, 1, 11.36, { retained: true, historyStatus: "updating" }))).toBe(true);
    for (const historyStatus of ["updating", "stale", "unavailable"] as const)
      expect(cumulativeFeesUpdating(ready(100, 1, null, { historyStatus }))).toBe(true);
    expect(cumulativeFeesUpdating(ready(100, 1, null, { historyStatus: "fresh" }))).toBe(false);
    expect(cumulativeFeesUpdating(ready(100, 1, null))).toBe(false);
    expect(cumulativeFeesUpdating(ready(100, 1, 5, { historyStatus: "updating" }))).toBe(false);
    expect(cumulativeFeesUpdating({ status: "failed" })).toBe(false);
    expect(cumulativeFeesUpdating({ status: "loading" })).toBe(false);
    expect(cumulativeFeesUpdating(undefined)).toBe(false);
  });
  it("matches what the totals count as cumulativePending (every pending row is labeled)", () => {
    const states: FiguresState[] = [ready(1, 1, null, { historyStatus: "updating" }), ready(1, 1, null, { historyStatus: "stale" }), ready(1, 1, 2), ready(1, 1, null)];
    expect(portfolioTotals(states).cumulativePending).toBe(2);
    expect(states.filter((state) => cumulativeFeesUpdating(state) && state.status === "ready" && state.figures.cumulativeFeesUsd === null)).toHaveLength(2);
  });
});
