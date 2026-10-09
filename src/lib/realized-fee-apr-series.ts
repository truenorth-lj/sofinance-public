import { aggregateCashflowsForPosition, type PositionCashflowEvent } from "./position-performance-events";
import { utcDate, utcDayStart } from "./apr-series";
import { feeAprFromRatio, holdingDaysFromSeconds, sideUsd } from "./position-performance-math";

export const REALIZED_FEE_APR_SERIES_LABEL = "Position realized fee APR (cumulative, on-chain events)";

export const REALIZED_FEE_APR_SERIES_ASSUMPTIONS = [
  "Points exist only on event days (open / increase / decrease) and the evaluation day.",
  "APR = cumulative fees ÷ deposited × 365 ÷ holding days, using current USD prices (not tx-time prices).",
  "Uncollected fees are included only on the evaluation day. Earlier days use collected fees only.",
  "Days without an event are gaps — values are not interpolated.",
].join(" ");

export type RealizedFeeAprKind = "event" | "evaluation";

export type RealizedFeeAprPoint = {
  time: number;
  date: string;
  aprPct: number | null;
  kind: RealizedFeeAprKind;
  includeUncollected: boolean;
};

export type RealizedFeeAprSeries = {
  label: string;
  assumptions: string;
  points: RealizedFeeAprPoint[];
};

export type RealizedHistoryItem = {
  blockTime: number | null;
  events: PositionCashflowEvent[];
};

/**
 * Sparse cumulative realized fee APR from already-parsed position events.
 * Does not fetch pool history and does not invent daily points.
 */
export function buildRealizedFeeAprSeries(input: {
  history: readonly RealizedHistoryItem[];
  positionMint: string;
  poolId: string;
  evaluatedAt: number;
  uncollectedFees: { a: bigint; b: bigint };
  priceUsdA: number | null;
  priceUsdB: number | null;
  decimalsA: number;
  decimalsB: number;
  openedAt: number | null;
}): RealizedFeeAprSeries {
  const byDay = new Map<number, RealizedFeeAprPoint>();
  const chronological = [...input.history];

  for (let index = 0; index < chronological.length; index += 1) {
    const item = chronological[index]!;
    if (item.blockTime === null || item.blockTime <= 0) continue;
    const events = chronological.slice(0, index + 1).flatMap((row) => row.events);
    const cash = aggregateCashflowsForPosition(events, input.positionMint, input.poolId);
    const point = pointFromCash({
      cash,
      asOf: item.blockTime,
      openedAt: input.openedAt ?? item.blockTime,
      uncollected: { a: 0n, b: 0n },
      includeUncollected: false,
      kind: "event",
      priceUsdA: input.priceUsdA,
      priceUsdB: input.priceUsdB,
      decimalsA: input.decimalsA,
      decimalsB: input.decimalsB,
    });
    if (point) byDay.set(point.time, point);
  }

  const allEvents = chronological.flatMap((row) => row.events);
  const latest = aggregateCashflowsForPosition(allEvents, input.positionMint, input.poolId);
  const evaluation = pointFromCash({
    cash: latest,
    asOf: input.evaluatedAt,
    openedAt: input.openedAt,
    uncollected: input.uncollectedFees,
    includeUncollected: true,
    kind: "evaluation",
    priceUsdA: input.priceUsdA,
    priceUsdB: input.priceUsdB,
    decimalsA: input.decimalsA,
    decimalsB: input.decimalsB,
  });
  if (evaluation) byDay.set(evaluation.time, evaluation);

  return {
    label: REALIZED_FEE_APR_SERIES_LABEL,
    assumptions: REALIZED_FEE_APR_SERIES_ASSUMPTIONS,
    points: [...byDay.values()].sort((a, b) => a.time - b.time),
  };
}

function pointFromCash(input: {
  cash: ReturnType<typeof aggregateCashflowsForPosition>;
  asOf: number;
  openedAt: number | null;
  uncollected: { a: bigint; b: bigint };
  includeUncollected: boolean;
  kind: RealizedFeeAprKind;
  priceUsdA: number | null;
  priceUsdB: number | null;
  decimalsA: number;
  decimalsB: number;
}): RealizedFeeAprPoint | null {
  if (input.openedAt === null || input.openedAt <= 0) return null;
  const depositedUsd = sideUsd(
    { a: input.cash.depositedA, b: input.cash.depositedB },
    input.decimalsA,
    input.decimalsB,
    input.priceUsdA,
    input.priceUsdB,
  );
  const feesUsd = sideUsd(
    {
      a: input.cash.feesCollectedA + input.uncollected.a,
      b: input.cash.feesCollectedB + input.uncollected.b,
    },
    input.decimalsA,
    input.decimalsB,
    input.priceUsdA,
    input.priceUsdB,
  );
  const holdingDays = holdingDaysFromSeconds(Math.max(0, input.asOf - input.openedAt));
  const aprPct =
    depositedUsd === null || feesUsd === null ? null : feeAprFromRatio(feesUsd, depositedUsd, holdingDays);
  return {
    time: utcDayStart(input.asOf),
    date: utcDate(input.asOf),
    aprPct,
    kind: input.kind,
    includeUncollected: input.includeUncollected,
  };
}
