import type { PositionPerformanceReport } from "@/lib/position-performance-report";

/**
 * Portfolio numbers for one position, read from its Performance report (the only source that has cumulative fees).
 * `null` = not known (shown as a dash, never as zero). Value is what the position holds now, unclaimed fees included
 * (the same "shares now" the Performance stock view shows).
 */
export type PositionFigures = {
  /** Plain ticker for same-stock pools ("TSLA"); null for other pools. */
  stock: string | null;
  shares: number | null;
  valueUsd: number | null;
  unclaimedFeesUsd: number | null;
  /** Collected plus unclaimed, since the first deposit. */
  cumulativeFeesUsd: number | null;
};

const finiteOrNull = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value : null;

export function positionFigures(report: PositionPerformanceReport | null | undefined): PositionFigures {
  const stock = report?.stock ?? null;
  return {
    stock: stock?.symbol ?? null,
    shares: finiteOrNull(stock?.sharesNow),
    valueUsd: finiteOrNull(stock?.valueUsd) ?? finiteOrNull(report?.metrics.currentEquityUsd),
    unclaimedFeesUsd: finiteOrNull(report?.metrics.uncollectedFeesUsd),
    cumulativeFeesUsd: finiteOrNull(report?.metrics.feesEarnedUsd) ?? finiteOrNull(stock?.feeUsd),
  };
}

/** One open position as the totals see it: its figures once read, or still loading / failed. */
export type FiguresState = { status: "loading" } | { status: "failed" } | { status: "ready"; figures: PositionFigures };

export type PortfolioTotals = {
  /** Open positions counted. */
  positions: number;
  valueUsd: number | null;
  unclaimedFeesUsd: number | null;
  cumulativeFeesUsd: number | null;
  /** Positions whose numbers are still being read; a total is shown only once this is 0. */
  pending: number;
  /** Positions whose numbers could not be read (or have no USD price): a total over the rest says so. */
  missing: number;
};

/**
 * The three numbers at the top of Portfolio. A total waits until every position is read, so it never grows while the
 * user reads it; a position that failed or has no price is left out and counted in `missing` (the card says so).
 * `extraValueUsd`: value of positions without a Performance report (Robinhood Chain), added to the LP total only.
 */
export function portfolioTotals(states: readonly FiguresState[], extraValue: readonly (number | null)[] = []): PortfolioTotals {
  const pending = states.filter((state) => state.status === "loading").length;
  const ready = states.flatMap((state) => state.status === "ready" ? [state.figures] : []);
  const sum = (values: (number | null)[]) => pending ? null : values.some((value) => value !== null)
    ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const values = [...ready.map((item) => item.valueUsd), ...extraValue];
  const missing = states.filter((state) => state.status === "failed").length
    + ready.filter((item) => item.valueUsd === null).length + extraValue.filter((value) => value === null).length;
  return {
    positions: states.length + extraValue.length,
    valueUsd: sum(values),
    unclaimedFeesUsd: sum(ready.map((item) => item.unclaimedFeesUsd)),
    cumulativeFeesUsd: sum(ready.map((item) => item.cumulativeFeesUsd)),
    pending,
    missing,
  };
}
