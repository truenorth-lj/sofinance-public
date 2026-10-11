import Decimal from "decimal.js";
import { isIncompleteUtcDay, SECONDS_PER_DAY } from "./apr-series";
import { averageCompleteDayAprPct, isThinPlanSample } from "./lp-plan-yield";

const D = Decimal.clone({ precision: 60 });

/** Trailing windows, in UTC days, that the Plan page compares. Same ranges as the daily APR charts. */
export const PLAN_APR_WINDOWS = [7, 30, 90] as const;

/** One UTC day of the pool's fee APR. `aprPct` is null for a gap (missing volume or TVL). */
export type DatedAprSample = {
  /** Unix seconds at 00:00 UTC of the day. */
  time: number;
  aprPct: number | null;
};

export type AprWindowAverage = {
  windowDays: number;
  /** Mean annualized fee APR over the finite days inside the window. */
  aprPct: string;
  /** Finite days that went into `aprPct` (gaps inside the window are skipped, never filled). */
  sampleDays: number;
};

export type BestPlanApr = AprWindowAverage & {
  /** Every window that had at least one finite day, so the UI can show what was passed over. */
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
  const aprPct = averageCompleteDayAprPct(inWindow);
  if (aprPct === null) return null;
  const sampleDays = inWindow.filter((point) => point.aprPct !== null && Number.isFinite(point.aprPct)).length;
  return { windowDays, aprPct, sampleDays };
}

/**
 * The "best" APR the Plan page projects with: the highest of the 7d / 30d / 90d trailing averages.
 *
 * - Windows with fewer than `PLAN_MIN_RELIABLE_SAMPLE_DAYS` finite days only compete when no window
 *   reaches that sample, so a few lucky days cannot beat a well-sampled average.
 * - Ties go to the longer window (more data behind the same number).
 * - This is the optimistic end of the pool's own recent history, not a forecast.
 *
 * Returns null when no window has a finite day.
 */
export function selectBestPlanApr(
  points: readonly DatedAprSample[],
  asOfSeconds?: number,
  windowSizes: readonly number[] = PLAN_APR_WINDOWS,
): BestPlanApr | null {
  const windows = windowSizes
    .map((size) => trailingWindowAverage(points, size, asOfSeconds))
    .filter((window): window is AprWindowAverage => window !== null);
  if (windows.length === 0) return null;
  const reliable = windows.filter((window) => !isThinPlanSample(window.sampleDays));
  const contenders = reliable.length > 0 ? reliable : windows;
  const best = contenders.reduce((top, next) => {
    const diff = new D(next.aprPct).cmp(top.aprPct);
    return diff > 0 || (diff === 0 && next.windowDays > top.windowDays) ? next : top;
  });
  return { ...best, windows };
}

/** "7-day" / "30-day" wording used in the UI. */
export function aprWindowLabel(windowDays: number): string {
  return `${windowDays}-day`;
}
