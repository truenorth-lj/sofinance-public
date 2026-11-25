import Decimal from "decimal.js";
import { isIncompleteUtcDay, SECONDS_PER_DAY } from "./apr-series";
import { isDataDay } from "./min-data-days";
import { averageCompleteDayAprPct, planAprContenders, PLAN_YIELD_DAYS_PER_YEAR } from "./lp-plan-yield";

const D = Decimal.clone({ precision: 60 });

/** Trailing windows, in UTC days, that the Plan page compares. Same ranges as the daily APR charts. */
export const PLAN_APR_WINDOWS = [7, 30, 90] as const;

/** One UTC day of the pool's fee APR. `aprPct` is null for a gap (missing volume or TVL). */
export type DatedAprSample = {
  /** Unix seconds at 00:00 UTC of the day. */
  time: number;
  aprPct: number | null;
  /** That day's pool TVL in USD, when known. With it, the window also reports the pool's USD fees per day. */
  tvlUsd?: number | null;
  /** That day's USD volume, when known (the day counts only with both, `isDataDay`). */
  volumeUsd?: number | null;
};

export type AprWindowAverage = {
  windowDays: number;
  /** Mean annualized fee APR over the finite days inside the window. */
  aprPct: string;
  /** Finite days that went into `aprPct` (gaps inside the window are skipped, never filled). */
  sampleDays: number;
  /** True when the series has no day before the window: the pool's whole history so far is inside it. */
  coversAllData: boolean;
  /**
   * USD fees the whole pool took per finite day of the window (each day's APR × that day's TVL ÷ 36,500), before any
   * protocol cut. Set only when every finite day has a TVL. This is the real money behind `aprPct`: a launch day of
   * $8k volume on a $248 pool averages to a huge APR but only ~$21 of fees, and projections are capped by it.
   */
  poolFeesPerDayUsd?: string;
};

export type BestPlanApr = AprWindowAverage & {
  /**
   * Every window that had at least one finite day and adds days a shorter window does not have (a 90-day window holding
   * the same 13 days as the 30-day one is dropped), so the UI can show what was passed over.
   */
  windows: AprWindowAverage[];
};

/**
 * Average fee APR of the trailing `windowDays` UTC days that end on the newest day in `points`.
 * Callers pass complete UTC days only (the pool-daily-apr route already drops the open day); pass
 * `asOfSeconds` to also drop any day that has not finished at that instant. Returns null when the
 * window holds no finite day.
 */
export function trailingWindowAverage(
  points: readonly DatedAprSample[],
  windowDays: number,
  asOfSeconds?: number,
): AprWindowAverage | null {
  if (!Number.isInteger(windowDays) || windowDays < 1) throw new Error("windowDays must be a positive integer");
  const complete =
    asOfSeconds === undefined ? points : points.filter((point) => !isIncompleteUtcDay(point.time, asOfSeconds));
  if (complete.length === 0) return null;
  const newest = Math.max(...complete.map((point) => point.time));
  const oldest = newest - (windowDays - 1) * SECONDS_PER_DAY;
  const inWindow = complete.filter((point) => point.time >= oldest && point.time <= newest);
  // Days of data: the same `isDataDay` count the cards and the calculator share (both volume and TVL; an APR alone is enough
  // for callers that pass no volume).
  const finite = inWindow.filter(hasData);
  const aprPct = averageCompleteDayAprPct(finite);
  if (aprPct === null) return null;
  const sampleDays = finite.length;
  // Any older day in the series (even one with no APR, e.g. a Raydium day before its TVL line starts) means the pool's
  // history goes back further than the window.
  const coversAllData = !complete.some((point) => point.time < oldest);
  const poolFeesPerDayUsd = poolFeesPerDay(finite);
  return poolFeesPerDayUsd === null
    ? { windowDays, aprPct, sampleDays, coversAllData }
    : { windowDays, aprPct, sampleDays, coversAllData, poolFeesPerDayUsd };
}

function hasData(point: DatedAprSample): boolean {
  return point.aprPct !== null && Number.isFinite(point.aprPct)
    && (point.volumeUsd === undefined || isDataDay({ volumeUsd: point.volumeUsd, tvlUsd: point.tvlUsd }));
}

/** Mean USD pool fees per day of `days` (APR × TVL ÷ 36,500 each), or null when any day lacks a usable TVL. */
function poolFeesPerDay(days: readonly DatedAprSample[]): string | null {
  if (days.length === 0) return null;
  let sum = new D(0);
  for (const day of days) {
    const tvl = day.tvlUsd;
    if (tvl === undefined || tvl === null || !Number.isFinite(tvl) || tvl < 0) return null;
    sum = sum.add(new D(day.aprPct ?? 0).mul(tvl).div(100).div(PLAN_YIELD_DAYS_PER_YEAR));
  }
  return sum.div(days.length).toFixed();
}

/**
 * The "best" APR the Plan page projects with: the highest of the 7d / 30d / 90d trailing averages.
 *
 * - A window counts only with `planMinSampleDays(windowDays)` days of data: at least 7 and 80% of its length
 *   (`planAprContenders`), so 13 days never stand in for a 90-day average and a few lucky days cannot beat a
 *   well-sampled one. Thinner windows compete only when no window qualifies (and then the numbers are hidden under 7).
 * - A longer window holding exactly as many days as a shorter one adds nothing and is dropped.
 * - Ties go to the shorter window (the same number, named by the narrowest window that has it).
 * - This is the optimistic end of the pool's own recent history, not a forecast.
 *
 * Returns null when no window has a finite day.
 */
export function selectBestPlanApr(
  points: readonly DatedAprSample[],
  asOfSeconds?: number,
  windowSizes: readonly number[] = PLAN_APR_WINDOWS,
): BestPlanApr | null {
  const windows = [...windowSizes]
    .sort((a, b) => a - b)
    .map((size) => trailingWindowAverage(points, size, asOfSeconds))
    .filter((window): window is AprWindowAverage => window !== null)
    .filter((window, index, all) => !all.slice(0, index).some((shorter) => shorter.sampleDays === window.sampleDays));
  if (windows.length === 0) return null;
  const best = planAprContenders(windows).reduce((top, next) => {
    const diff = new D(next.aprPct).cmp(top.aprPct);
    return diff > 0 || (diff === 0 && next.windowDays < top.windowDays) ? next : top;
  });
  return { ...best, windows };
}

/**
 * "30-day avg" when the window is full. Otherwise it is named by its days of data, never by the longer window: "13-day
 * avg (all data so far)" for a young pool whose whole history is inside it, "29-day avg (gap days skipped)" when days
 * inside the window had no data (e.g. a Raydium pool whose daily TVL line holds 29 complete days of the last 30).
 */
export function aprWindowAvgLabel(
  window: { windowDays: number; sampleDays: number; coversAllData?: boolean },
  avg = "avg",
): string {
  if (window.sampleDays >= window.windowDays) return `${aprWindowLabel(window.windowDays)} ${avg}`;
  const why = window.coversAllData === false ? "gap days skipped" : "all data so far";
  return `${aprWindowLabel(window.sampleDays)} ${avg} (${why})`;
}

/** "7-day" / "30-day" wording used in the UI. */
export function aprWindowLabel(windowDays: number): string {
  return `${windowDays}-day`;
}
