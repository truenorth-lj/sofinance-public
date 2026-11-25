import Decimal from "decimal.js";
import { validNumber } from "./lp-accounting";
import { MAX_PLAN_DAYS } from "./lp-intent";
import { MIN_APR_DATA_DAYS } from "./min-data-days";

const D = Decimal.clone({ precision: 60 });

/** Fee APR points are already annualized with a 365-day year. */
export const PLAN_YIELD_DAYS_PER_YEAR = 365;

/**
 * Assumed all-in cost of creating a position and adding liquidity, in basis points of the deposit
 * (100 bps = 1%). It is a planning assumption, not a quote and not the on-chain protocol fee.
 */
export const PLAN_OPEN_COST_BPS = 100;

/**
 * Assumed swap cost (price impact and slippage) of one USDC swap through the pool, in basis points of the amount
 * swapped: the USDC deposit into the pool tokens on day 0, and the tokens back to USDC on close. The same 1% planning
 * assumption Raydium's open and close have always used, shared by every DEX so both are estimated one way; a DEX's own
 * platform fee is added on top.
 */
export const PLAN_SWAP_COST_BPS = PLAN_OPEN_COST_BPS;

/** `PLAN_OPEN_COST_BPS` as a percent string for display, e.g. "1". */
export function planOpenCostPctLabel(bps: number = PLAN_OPEN_COST_BPS): string {
  return new D(bps).div(100).toFixed();
}

/** Complete UTC days needed before any projection is shown (same bar as the cards). */
export const PLAN_MIN_RELIABLE_SAMPLE_DAYS = MIN_APR_DATA_DAYS;

/** Share of a trailing window's days that must hold data before that window can be picked as the best average. */
export const PLAN_WINDOW_MIN_COVERAGE = 0.8;

/**
 * Days of data a trailing window needs to count: `PLAN_MIN_RELIABLE_SAMPLE_DAYS`, and for a window of `windowDays` also
 * 80% of its length (a 30-day window needs 24 days, a 90-day window 72), so a short history never stands in for a long
 * window. Without `windowDays` it is the 1-day bar below which nothing is shown.
 */
export function planMinSampleDays(windowDays?: number): number {
  if (windowDays === undefined) return PLAN_MIN_RELIABLE_SAMPLE_DAYS;
  return Math.max(PLAN_MIN_RELIABLE_SAMPLE_DAYS, Math.ceil(PLAN_WINDOW_MIN_COVERAGE * windowDays));
}

/** Too few days of data: under 1 overall, or, given the window's length, under `planMinSampleDays(windowDays)`. */
export function isThinPlanSample(sampleDays: number, windowDays?: number): boolean {
  return sampleDays < planMinSampleDays(windowDays);
}

/**
 * The windows that may be picked (best or low): the ones that pass `isThinPlanSample` for their own length; when none
 * does, the ones with at least one complete day; when none has that either, all of them (the caller then hides the numbers).
 */
export function planAprContenders<W extends { windowDays: number; sampleDays: number }>(windows: readonly W[]): readonly W[] {
  const covered = windows.filter((window) => !isThinPlanSample(window.sampleDays, window.windowDays));
  if (covered.length > 0) return covered;
  const week = windows.filter((window) => !isThinPlanSample(window.sampleDays));
  return week.length > 0 ? week : windows;
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
  /**
   * A year of the projection as a percent: `aprPct` compounded daily (held to the fee cap) with `growth: "compound"`;
   * with `growth: "simple"` nothing compounds and it equals `cappedAprPct`.
   */
  apyPct: string;
  /**
   * `aprPct` held to the pool's real fees for this deposit (`poolFeeSharePerDay`), as a simple yearly percent, never
   * compounded: day one's fees × 365 ÷ capital. The number shown under "Est. fee APR" (same basis as the cards).
   */
  cappedAprPct: string;
  /** Trailing window (in UTC days) whose average produced `aprPct`. */
  aprWindowDays: number;
  dailyRate: string;
  entryCost: string;
  /** Closing cost as basis points of what the position is worth when you exit (0 when none is assumed). */
  exitCostBps: number;
  /** That closing cost in USDC at the end of the period. */
  exitCost: string;
  /** Fees the position earned over the period, before the opening and closing costs. */
  feesEarned: string;
  /** True when the pool's real fees (`PlanYieldInput.feeCap`) held the projection below the average APR on some day. */
  feeCapped: boolean;
  sampleDays: number;
  points: PlanYieldPoint[];
  breakEvenDay: number | null;
  endSofinance: string;
  endHold: string;
  vsHold: string;
  /** Capital plus `endSofinance`: what you walk away with at the end, after the opening and closing costs. */
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
  /**
   * Paid when you exit, as basis points of what the position is worth then (e.g. swapping back to USDC). Every point of
   * the curve is "if you closed on that day", so break-even waits until fees cover both costs. Defaults to 0.
   */
  exitCostBps?: number;
  /**
   * The pool's real fee income, so the projection never collects more than the pool paid out. Each day the position
   * takes the smaller of its APR share and `poolLpFeesPerDayUsd × value ÷ (poolTvlUsd + value)`: what the LPs got per day,
   * split with everyone already in the pool. Omitted, the APR compounds unchecked (the old behaviour).
   */
  feeCap?: PlanFeeCap;
  /**
   * "compound" (default, the Plan page): fees are added to the position every day. "simple" (the Calculate dialog and
   * the homepage estimator): the deposit earns the same fees every day and nothing compounds, like the cards' APR.
   */
  growth?: "compound" | "simple";
};

export type PlanFeeCap = {
  /** USD fees the pool's LPs (after the DEX's cut) took per day over the averaged window. */
  poolLpFeesPerDayUsd: string;
  /** Pool TVL in USD before your deposit; 0 when unknown, which caps at the pool's whole fee income. */
  poolTvlUsd: string;
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

function requireExitBps(exitCostBps: number): number {
  if (!Number.isInteger(exitCostBps) || exitCostBps < 0 || exitCostBps > 10_000) throw new Error("exitCostBps is invalid");
  return exitCostBps;
}

/**
 * What the position is worth on `day` before closing it: capital compounded daily, minus the day-0 entry cost.
 */
function valueBeforeExit(cap: Decimal, dailyRate: Decimal, days: number, cost: Decimal): Decimal {
  return cap.mul(dailyRate.add(1).pow(days)).sub(cost);
}

/**
 * Cumulative profit after `days` of daily auto-compounding if you closed then: minus the day-0 entry cost and the
 * closing cost (`exitCostBps` of what the position is worth on that day). Hold of a two-sided same-asset RWA pair is
 * treated as 0.
 */
export function compoundedProfit(capital: string, dailyRate: Decimal, days: number, entryCost = "0", exitCostBps = 0): Decimal {
  requireDayCount(days, "days", 0);
  const cap = requireDecimal(capital, "capital", "0");
  if (cap.lte(0)) throw new Error("capital must be greater than zero");
  const cost = requireDecimal(entryCost, "entryCost", "0");
  if (!dailyRate.isFinite()) throw new Error("dailyRate is invalid");
  const value = valueBeforeExit(cap, dailyRate, days, cost);
  return value.mul(new D(10_000).sub(requireExitBps(exitCostBps)).div(10_000)).sub(cap);
}

/**
 * First whole day (0–maxDays) at which SoFinance profit, after the opening and closing costs, is ≥ 0, or null when it
 * never gets there. With no costs at all, a non-negative rate breaks even on day 0.
 */
export function breakEvenDay(capital: string, dailyRate: Decimal, entryCost = "0", maxDays = MAX_PLAN_DAYS, exitCostBps = 0): number | null {
  requireDayCount(maxDays, "maxDays", 1);
  const cost = requireDecimal(entryCost, "entryCost", "0");
  if (cost.lte(0) && requireExitBps(exitCostBps) === 0) return dailyRate.gte(0) ? 0 : null;
  if (dailyRate.lte(0)) return null;
  return firstDayAtLeast(capital, dailyRate, "0", entryCost, maxDays, exitCostBps);
}

/**
 * Gross position value (before the opening and closing costs) on each day 0–`days`, compounding daily but never taking
 * more fees in a day than `cap` allows: the pool's LP fees per day × your share of the pool after your deposit. Same
 * basis as `compoundedProfit` (capital grows, the entry cost is subtracted after).
 */
/**
 * USD fees per day a deposit of `value` can take from a pool whose LPs took `poolLpFeesPerDayUsd` a day: its share of the
 * pool once it is in, `fees × value ÷ (tvl + value)`. The one cap rule behind the calculator projection
 * (`cappedGrowthPath`) and the card and table APR (`capAprAtPoolFees`).
 */
export function poolFeeSharePerDay(poolLpFeesPerDayUsd: Decimal, poolTvlUsd: Decimal, value: Decimal): Decimal {
  return poolLpFeesPerDayUsd.mul(value).div(poolTvlUsd.add(value));
}

function poolFeeShareOf(cap: PlanFeeCap, value: Decimal): Decimal {
  const fees = requireDecimal(cap.poolLpFeesPerDayUsd, "poolLpFeesPerDayUsd", "0");
  return poolFeeSharePerDay(fees, requireDecimal(cap.poolTvlUsd, "poolTvlUsd", "0"), value);
}

export function cappedGrowthPath(capital: string, dailyRate: Decimal, days: number, cap: PlanFeeCap): { values: Decimal[]; cappedFromDay: number | null } {
  requireDayCount(days, "days", 0);
  const fees = requireDecimal(cap.poolLpFeesPerDayUsd, "poolLpFeesPerDayUsd", "0");
  const tvl = requireDecimal(cap.poolTvlUsd, "poolTvlUsd", "0");
  let value = requireDecimal(capital, "capital", "0");
  if (value.lte(0)) throw new Error("capital must be greater than zero");
  const values = [value];
  let cappedFromDay: number | null = null;
  for (let day = 1; day <= days; day++) {
    const byApr = value.mul(dailyRate);
    const byPool = poolFeeSharePerDay(fees, tvl, value);
    const capped = byPool.lt(byApr);
    if (capped && cappedFromDay === null) cappedFromDay = day;
    value = value.add(capped ? byPool : byApr);
    values.push(value);
  }
  return { values, cappedFromDay };
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
  const exitCostBps = requireExitBps(input.exitCostBps ?? 0);
  const capital = requireDecimal(input.capital, "capital", "0");
  const entry = requireDecimal(entryCost, "entryCost", "0");
  // Day one's fees: the APR's share, held to the pool's real fees for this deposit. Simple growth earns this every day.
  const byApr = capital.mul(rate);
  const byPool = input.feeCap ? poolFeeShareOf(input.feeCap, capital) : null;
  const firstDayCapped = byPool !== null && byPool.lt(byApr);
  const firstDayFees = firstDayCapped ? byPool! : byApr;
  const simple = input.growth === "simple";
  // Compounding with a fee cap is a day-by-day path (to a full year, for break-even and the one-year rate); without it,
  // the closed form `capital × (1 + rate)^day` as before.
  const path = !simple && input.feeCap ? cappedGrowthPath(input.capital, rate, MAX_PLAN_DAYS, input.feeCap) : null;
  const grownOn = (day: number) => simple
    ? capital.add(firstDayFees.mul(day))
    : path ? path.values[day]! : capital.mul(rate.add(1).pow(day));
  const profitOn = (day: number) => simple || path
    ? grownOn(day).sub(entry).mul(new D(10_000).sub(exitCostBps).div(10_000)).sub(capital)
    : compoundedProfit(input.capital, rate, day, entryCost, exitCostBps);
  const cappedAprPct = firstDayFees.mul(PLAN_YIELD_DAYS_PER_YEAR).div(capital).mul(100).toFixed();
  const points: PlanYieldPoint[] = [];
  for (let day = 0; day <= days; day++) {
    points.push({ day, sofinance: profitOn(day).toFixed(), hold: "0" });
  }
  const endSofinance = points[days]!.sofinance;
  const endHold = "0";
  const vsHold = new D(endSofinance).sub(endHold).toFixed();
  const exitValue = new D(input.capital).add(endSofinance).toFixed();
  const grown = grownOn(days);
  return {
    days,
    capital: capital.toFixed(),
    aprPct: requireDecimal(input.aprPct, "aprPct").toFixed(),
    // Capped: what a year of the capped path actually grows by, not the uncapped APR compounded.
    apyPct: simple ? cappedAprPct
      : path ? grownOn(PLAN_YIELD_DAYS_PER_YEAR).div(capital).sub(1).mul(100).toFixed() : aprToApyPct(input.aprPct),
    cappedAprPct,
    aprWindowDays: input.aprWindowDays,
    dailyRate: rate.toFixed(),
    entryCost: entry.toFixed(),
    exitCostBps,
    exitCost: grown.sub(entry).mul(exitCostBps).div(10_000).toFixed(),
    feesEarned: grown.sub(capital).toFixed(),
    feeCapped: simple ? firstDayCapped : path !== null && path.cappedFromDay !== null && path.cappedFromDay <= days,
    sampleDays: input.sampleDays,
    points,
    breakEvenDay: simple || path
      ? firstDayWhere((day) => profitOn(day).gte(0), MAX_PLAN_DAYS)
      : breakEvenDay(input.capital, rate, entryCost, MAX_PLAN_DAYS, exitCostBps),
    endSofinance,
    endHold,
    vsHold,
    exitValue,
    endGainPct: new D(endSofinance).div(capital).mul(100).toFixed(),
  };
}

function firstDayWhere(test: (day: number) => boolean, maxDays: number): number | null {
  for (let day = 0; day <= maxDays; day++) if (test(day)) return day;
  return null;
}

function firstDayAtLeast(
  capital: string,
  dailyRate: Decimal,
  target: string,
  entryCost: string,
  maxDays: number,
  exitCostBps = 0,
): number | null {
  const goal = requireDecimal(target, "target", "0");
  for (let day = 0; day <= maxDays; day++) {
    if (compoundedProfit(capital, dailyRate, day, entryCost, exitCostBps).gte(goal)) return day;
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
