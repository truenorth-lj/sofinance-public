import Decimal from "decimal.js";
import { buildDecision, costTotal, type DecisionResponse } from "./lp-decision";

// Read-only "plan" layer over the deterministic sample engine in lp-decision.
// It only judges a user's stated goal against the engine's sample paths; it never
// produces probabilities, quotes or anything executable.
const D = Decimal.clone({ precision: 60 });
const DAY_MS = 86_400_000;

export const MAX_PLAN_DAYS = 365;
export const MAX_PLAN_USDC = "10000000";

export type IntentGoal = "net-by-date" | "take-profit" | "beat-holding";
export type ExitAsset = "usdc" | "tokens";
export type Intent = {
  days: number;
  amount: string;
  goal: IntentGoal;
  target: string;
  lossAlert: string;
  exitAsset: ExitAsset;
};

export type StrategyKey = "hold" | "rerange" | "exit";
export type ScenarioOutlook = {
  id: string;
  title: string;
  short: string;
  blurb: string;
  priceChangePct: string;
  dailyVolume: string;
  nets: Record<StrategyKey, string | null>;
  rebalances: number;
  vsHolding: string | null;
  /** The number judged against the target for the chosen goal. */
  outcome: string | null;
  reachesTarget: boolean;
  shortfall: string | null;
  triggersAlert: boolean;
};
export type IntentOutlook = {
  mode: "new" | "existing";
  asOf: string;
  targetDate: string;
  days: number;
  targetPct: string;
  targetAnnualizedPct: string;
  lossAlertPct: string;
  scenarios: ScenarioOutlook[];
  reached: number;
  alerts: number;
  assumedCosts: { hold: string | null; perRerange: string | null; exit: string | null };
  /** What every sample path shares, as percentages around the entry price. */
  assumptions: {
    rangeLowPct: string;
    rangeHighPct: string;
    feePct: string;
    rerange: { bandLowPct: string; bandHighPct: string; cooldownDays: number; maxRebalances: number } | null;
  } | null;
};

const SCENARIO_COPY: Record<string, { title: string; short: string; blurb: string }> = {
  flat: {
    title: "Sideways",
    short: "Sideways",
    blurb: "Price ends where it started and volume stays steady, so fees accrue the whole time.",
  },
  loss: {
    title: "Slides out",
    short: "Slide",
    blurb: "Price ends below your range on thin volume. No fees are counted at the end point.",
  },
  tail: {
    title: "Gap down",
    short: "Gap",
    blurb: "A sharp gap with no trading volume. No fees, and the deepest inventory loss.",
  },
};

/** Accepts "1,000.50"-style input; returns a canonical positive decimal string or null. */
export function parseUsdc(input: string, max: string = MAX_PLAN_USDC): string | null {
  const text = input.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{0,6})?$/.test(text)) return null;
  const value = new D(text);
  if (value.lte(0) || value.gt(max)) return null;
  return value.toFixed();
}

export function parseDays(input: string): number | null {
  if (!/^\d{1,3}$/.test(input.trim())) return null;
  const days = Number(input.trim());
  return days >= 1 && days <= MAX_PLAN_DAYS ? days : null;
}

function runSample(amount: string, days: number, nowMs: number, positionId?: string): DecisionResponse {
  return buildDecision(
    {
      requestId: "plan-sample",
      contextVersion: 0,
      positionId,
      amountAtomic: new D(amount).mul(1_000_000).toFixed(0),
      asset: "USDC",
      decimals: 6,
      numeraire: "USDC",
      targetDate: new Date(nowMs + days * DAY_MS).toISOString(),
      demo: true,
    },
    new Date(nowMs).toISOString(),
  );
}

// Value change of simply holding the token basket the position starts with.
// Same concentrated-liquidity inventory formula the engine uses for principal.
function holdingNet(capital: Decimal, start: Decimal, end: Decimal, lower: Decimal, upper: Decimal): Decimal {
  const s = D.max(lower.sqrt(), D.min(start.sqrt(), upper.sqrt()));
  const unitA = new D(1).div(s).sub(new D(1).div(upper.sqrt()));
  const unitB = s.sub(lower.sqrt());
  const liquidity = capital.div(unitA.mul(start).add(unitB));
  return unitA.mul(liquidity).mul(end).add(unitB.mul(liquidity)).sub(capital);
}

const pctAround = (bound: string, reference: string) => new D(bound).div(reference).sub(1).mul(100).toFixed();

function outlookFor(decision: DecisionResponse, intent: Intent): ScenarioOutlook[] {
  const capital = new D(intent.amount);
  const target = new D(intent.target);
  const alert = new D(intent.lossAlert);
  return decision.scenarios.map((scenario) => {
    const row = (key: StrategyKey) => scenario.strategies.find((s) => s.strategy === key);
    const nets = {
      hold: row("hold")?.net.value ?? null,
      rerange: row("rerange")?.net.value ?? null,
      exit: row("exit")?.net.value ?? null,
    };
    const { path, lower, upper } = scenario.assumptions;
    const start = new D(path[0]!.priceBPerA);
    const end = new D(path.at(-1)!.priceBPerA);
    const vsHolding =
      nets.hold === null
        ? null
        : new D(nets.hold).sub(holdingNet(capital, start, end, new D(lower), new D(upper))).toFixed();
    const outcome = intent.goal === "beat-holding" ? vsHolding : nets.hold;
    const reachesTarget = outcome !== null && new D(outcome).gte(target);
    const copy = SCENARIO_COPY[scenario.id];
    return {
      id: scenario.id,
      title: copy?.title ?? scenario.label,
      short: copy?.short ?? scenario.label,
      blurb: copy?.blurb ?? scenario.assumptions.source,
      priceChangePct: end.div(start).sub(1).mul(100).toFixed(),
      dailyVolume: new D(path.at(-1)!.volumeB).div(path.at(-1)!.day).toFixed(),
      nets,
      rebalances: row("rerange")?.rebalances.length ?? 0,
      vsHolding,
      outcome,
      reachesTarget,
      shortfall: outcome === null || reachesTarget ? null : target.sub(outcome).toFixed(),
      triggersAlert: nets.hold !== null && new D(nets.hold).lte(alert.neg()),
    };
  });
}

export function evaluateIntent(intent: Intent, nowMs: number, positionId?: string): IntentOutlook {
  const decision = runSample(intent.amount, intent.days, nowMs, positionId);
  const scenarios = outlookFor(decision, intent);
  const targetPct = new D(intent.target).div(intent.amount).mul(100);
  const assumptions = decision.scenarios[0]?.assumptions;
  return {
    mode: decision.mode,
    asOf: decision.asOf,
    targetDate: new Date(nowMs + intent.days * DAY_MS).toISOString(),
    days: intent.days,
    targetPct: targetPct.toFixed(),
    targetAnnualizedPct: targetPct.mul(MAX_PLAN_DAYS).div(intent.days).toFixed(),
    lossAlertPct: new D(intent.lossAlert).div(intent.amount).mul(100).toFixed(),
    scenarios,
    reached: scenarios.filter((s) => s.reachesTarget).length,
    alerts: scenarios.filter((s) => s.triggersAlert).length,
    assumedCosts: {
      hold: assumptions ? costTotal(assumptions.costs.hold).value : null,
      perRerange: assumptions?.rerangePolicy ? costTotal(assumptions.rerangePolicy.costsPerRebalance).value : null,
      exit: assumptions ? costTotal(assumptions.costs.exit).value : null,
    },
    assumptions: assumptions
      ? {
          rangeLowPct: pctAround(assumptions.lower, assumptions.path[0]!.priceBPerA),
          rangeHighPct: pctAround(assumptions.upper, assumptions.path[0]!.priceBPerA),
          feePct: new D(assumptions.feeRate).mul(100).toFixed(),
          rerange: assumptions.rerangePolicy
            ? {
                bandLowPct: pctAround(assumptions.rerangePolicy.lowerFactor, "1"),
                bandHighPct: pctAround(assumptions.rerangePolicy.upperFactor, "1"),
                cooldownDays: assumptions.rerangePolicy.cooldownDays,
                maxRebalances: assumptions.rerangePolicy.maxRebalances,
              }
            : null,
        }
      : null,
  };
}

/**
 * Fewest whole days (≤ 365) the first sample path needs to reach the target, or
 * null when it does not get there within a year. Assumes that path's outcome
 * does not shrink as the horizon grows, which holds for the steady-volume path.
 */
export function paceToTarget(
  intent: Intent,
  nowMs: number,
  positionId?: string,
): { scenarioId: string; days: number | null } | null {
  const at = (days: number) =>
    outlookFor(runSample(intent.amount, days, nowMs, positionId), { ...intent, days })[0];
  const year = at(MAX_PLAN_DAYS);
  if (!year) return null;
  if (!year.reachesTarget) return { scenarioId: year.id, days: null };
  const first = at(1);
  if (first?.reachesTarget) return { scenarioId: year.id, days: 1 };

  let low = 2;
  let high = MAX_PLAN_DAYS;
  // The steady path earns the same each day, so two points usually pin the answer.
  // The guess is still checked, and anything non-linear falls through to the search.
  if (first && first.outcome !== null && year.outcome !== null) {
    const perDay = new D(year.outcome).sub(first.outcome).div(MAX_PLAN_DAYS - 1);
    if (perDay.gt(0)) {
      const estimate = new D(intent.target).sub(first.outcome).div(perDay).add(1).ceil().toNumber();
      const guess = Math.min(high, Math.max(low, estimate));
      if (at(guess)?.reachesTarget) high = guess;
      else low = guess + 1;
      if (high === guess && guess > low && !at(guess - 1)?.reachesTarget) low = guess;
    }
  }
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (at(mid)?.reachesTarget) high = mid;
    else low = mid + 1;
  }
  return { scenarioId: year.id, days: low };
}
