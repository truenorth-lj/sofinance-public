import Decimal from "decimal.js";
import { validNumber } from "./lp-accounting";
import { MAX_PLAN_DAYS } from "./lp-intent";

const D = Decimal.clone({ precision: 60 });

/** Fee APR points are already annualized with a 365-day year. */
export const PLAN_YIELD_DAYS_PER_YEAR = 365;

/**
 * Assumed all-in cost of creating a position and adding liquidity, in basis points of the deposit
 * (100 bps = 1%). It is a planning assumption, not a quote and not the on-chain protocol fee.
 */
export const PLAN_OPEN_COST_BPS = 100;

/** `PLAN_OPEN_COST_BPS` as a percent string for display, e.g. "1". */
export function planOpenCostPctLabel(bps: number = PLAN_OPEN_COST_BPS): string {
  return new D(bps).div(100).toFixed();
}

/** Complete UTC days needed before the average is shown as a normal headline. */
export const PLAN_MIN_RELIABLE_SAMPLE_DAYS = 7;

export function isThinPlanSample(sampleDays: number): boolean {
  return sampleDays < PLAN_MIN_RELIABLE_SAMPLE_DAYS;
}

/**
 * Day-0 entry cost: `PLAN_OPEN_COST_BPS` (about 1%) of `capital` for creating the position and adding
 * liquidity. Network / gas fees are ignored.
 */
export function planEntryCost(capital: string, costBps: number = PLAN_OPEN_COST_BPS): string {
  const cap = requireDecimal(capital, "capital", "0");
  if (cap.lte(0)) throw new Error("capital must be greater than zero");
  if (!Number.isInteger(costBps) || costBps < 0 || costBps > 10_000) throw new Error("costBps is invalid");
  return cap.mul(costBps).div(10_000).toFixed();
}

export type AprSample = { aprPct: number | null };

export type PlanYieldPoint = {
  day: number;
  sofinance: string;
  hold: string;
};

export type PlanYieldComparison = {
  days: number;
  capital: string;
  aprPct: string;
  /** `aprPct` compounded daily over a 365-day year, as a percent. */
  apyPct: string;
  /** Trailing window (in UTC days) whose average produced `aprPct`. */
  aprWindowDays: number;
  dailyRate: string;
  entryCost: string;
  sampleDays: number;
  points: PlanYieldPoint[];
  breakEvenDay: number | null;
  endSofinance: string;
  endHold: string;
  vsHold: string;
  /** Capital plus `endSofinance`: what the position is worth at the end, after the day-0 entry cost. */
  exitValue: string;
  /** `endSofinance` as a percent of `capital`. */
  endGainPct: string;
};

export type PlanYieldInput = {
  capital: string;
  days: number;
  aprPct: string;
  /** Complete UTC days that produced `aprPct`. Informational; not used in the math. */
  sampleDays: number;
  /** Trailing window (in UTC days) that `aprPct` averages. Informational; not used in the math. */
  aprWindowDays: number;
  /** Paid at day 0 and not compounded. Defaults to 0 (network fees ignored). */
  entryCost?: string;
};

/**
 * Mean of complete UTC days that have a finite APR. Gaps (`null`) are skipped,
 * never interpolated. Returns null when nothing can be averaged.
 */
export function averageCompleteDayAprPct(points: readonly AprSample[]): string | null {
  let sum = new D(0);
  let count = 0;
  for (const point of points) {
    if (point.aprPct === null || !Number.isFinite(point.aprPct)) continue;
    sum = sum.add(point.aprPct);
    count += 1;
  }
  return count === 0 ? null : sum.div(count).toFixed();
}

/** Simple daily rate implied by an annualized percent: apr% / 100 / 365. */
export function dailyRateFromAprPct(aprPct: string): Decimal {
  return requireDecimal(aprPct, "aprPct").div(100).div(PLAN_YIELD_DAYS_PER_YEAR);
}

/** Effective annual yield of an APR that compounds daily: ((1 + apr/365)^365 − 1) as a percent. */
export function aprToApyPct(aprPct: string): string {
  return dailyRateFromAprPct(aprPct)
    .add(1)
    .pow(PLAN_YIELD_DAYS_PER_YEAR)
    .sub(1)
    .mul(100)
    .toFixed();
}

/**
 * Cumulative profit after `days` of daily auto-compounding, minus an optional
 * day-0 entry cost. Hold of a two-sided same-asset RWA pair is treated as 0.
 */
export function compoundedProfit(capital: string, dailyRate: Decimal, days: number, entryCost = "0"): Decimal {
  requireDayCount(days, "days", 0);
  const cap = requireDecimal(capital, "capital", "0");
  if (cap.lte(0)) throw new Error("capital must be greater than zero");
  const cost = requireDecimal(entryCost, "entryCost", "0");
  if (!dailyRate.isFinite()) throw new Error("dailyRate is invalid");
  return cap.mul(dailyRate.add(1).pow(days)).sub(cap).sub(cost);
}

/**
 * First whole day (0–maxDays) at which SoFinance profit is ≥ 0, or null when
 * it never gets there. Zero entry cost and a non-negative rate break even on day 0.
 */
export function breakEvenDay(capital: string, dailyRate: Decimal, entryCost = "0", maxDays = MAX_PLAN_DAYS): number | null {
  requireDayCount(maxDays, "maxDays", 1);
  const cost = requireDecimal(entryCost, "entryCost", "0");
  if (cost.lte(0)) return dailyRate.gte(0) ? 0 : null;
  if (dailyRate.lte(0)) return null;
  return firstDayAtLeast(capital, dailyRate, "0", entryCost, maxDays);
}

export function buildPlanComparison(input: PlanYieldInput): PlanYieldComparison {
  const days = input.days;
  requireDayCount(days, "days", 1);
  if (!Number.isInteger(input.sampleDays) || input.sampleDays < 0) {
    throw new Error("sampleDays must be a non-negative integer");
  }
  if (!Number.isInteger(input.aprWindowDays) || input.aprWindowDays < 1) {
    throw new Error("aprWindowDays must be a positive integer");
  }
  const rate = dailyRateFromAprPct(input.aprPct);
  const entryCost = input.entryCost ?? "0";
  const points: PlanYieldPoint[] = [];
  for (let day = 0; day <= days; day++) {
    points.push({
      day,
      sofinance: compoundedProfit(input.capital, rate, day, entryCost).toFixed(),
      hold: "0",
    });
  }
  const endSofinance = points[days]!.sofinance;
  const endHold = "0";
  const vsHold = new D(endSofinance).sub(endHold).toFixed();
  const exitValue = new D(input.capital).add(endSofinance).toFixed();
  const capital = requireDecimal(input.capital, "capital", "0");
  return {
    days,
    capital: capital.toFixed(),
    aprPct: requireDecimal(input.aprPct, "aprPct").toFixed(),
    apyPct: aprToApyPct(input.aprPct),
    aprWindowDays: input.aprWindowDays,
    dailyRate: rate.toFixed(),
    entryCost: requireDecimal(entryCost, "entryCost", "0").toFixed(),
    sampleDays: input.sampleDays,
    points,
    breakEvenDay: breakEvenDay(input.capital, rate, entryCost, MAX_PLAN_DAYS),
    endSofinance,
    endHold,
    vsHold,
    exitValue,
    endGainPct: new D(endSofinance).div(capital).mul(100).toFixed(),
  };
}

function firstDayAtLeast(
  capital: string,
  dailyRate: Decimal,
  target: string,
  entryCost: string,
  maxDays: number,
): number | null {
  const goal = requireDecimal(target, "target", "0");
  for (let day = 0; day <= maxDays; day++) {
    if (compoundedProfit(capital, dailyRate, day, entryCost).gte(goal)) return day;
  }
  return null;
}

function requireDecimal(value: string, name: string, minimum?: string): Decimal {
  if (minimum === undefined) {
    try {
      const parsed = new D(value);
      if (!parsed.isFinite()) throw new Error();
      return parsed;
    } catch {
      throw new Error(`${name} is invalid`);
    }
  }
  if (!validNumber(value, minimum)) throw new Error(`${name} is invalid`);
  return new D(value);
}

function requireDayCount(days: number, name: string, min: number) {
  if (!Number.isInteger(days) || days < min || days > MAX_PLAN_DAYS) {
    throw new Error(`${name} must be an integer ${min}–${MAX_PLAN_DAYS}`);
  }
}
