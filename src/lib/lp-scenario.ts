import Decimal from "decimal.js";
import { available, unavailable, validNumber, costTotal, excessNet, type Cost, type Metric } from "./lp-accounting";
const D = Decimal.clone({ precision: 120 });
export type PathPoint = { day: number; priceBPerA: string; volumeB: string; activeLiquidity: string };
export type RerangePolicy = {
  trigger: { kind: "outside-range" } | { kind: "price"; direction: "below" | "above"; price: string };
  lowerFactor: string; upperFactor: string; cooldownDays: number; maxRebalances: number; costsPerRebalance: Cost[];
};
export type ExitBasis = { kind: "demo" | "quote"; route: "convert" | "retain-tokens"; grossB: string; tokens?: { a: string; b: string }; source: string; quotedAt: string; expiresAt: string | null };
export type Scenario = {
  freshness: "demo" | "fresh" | "stale" | "missing"; id: string; label: string;
  path: PathPoint[]; feeRate: string; lower: string; upper: string;
  costs: { hold: Cost[]; rerange: Cost[]; exit: Cost[] }; source: string; asOf: string; risks: string[];
  rerangePolicy?: RerangePolicy; exitBasis?: ExitBasis;
};
export type RebalanceEvent = { day: number; price: string; lower: string; upper: string; cost: string };
export type StrategyResult = { strategy: "hold" | "rerange" | "exit"; net: Metric; breakevenDay: number | null; breakevenReason: string; deltaVsHold: Metric; rebalances: RebalanceEvent[] };
function unitValue(price: Decimal, lower: Decimal, upper: Decimal) {
  const s = D.max(lower.sqrt(), D.min(price.sqrt(), upper.sqrt()));
  return new D(1).div(s).sub(new D(1).div(upper.sqrt())).mul(price).add(s.sub(lower.sqrt()));
}
function validRange(lower: string, upper: string) { return validNumber(lower) && validNumber(upper) && new D(lower).gt(0) && new D(upper).gt(lower); }
function validPolicy(p: RerangePolicy | undefined) {
  return p && validRange(p.lowerFactor, p.upperFactor) && new D(p.lowerFactor).lt(1) && new D(p.upperFactor).gt(1) && Number.isFinite(p.cooldownDays) && p.cooldownDays >= 0 && Number.isInteger(p.maxRebalances) && p.maxRebalances >= 0 && p.maxRebalances <= 100 && (p.trigger.kind === "outside-range" || (validNumber(p.trigger.price) && new D(p.trigger.price).gt(0)));
}
function exitResult(s: Scenario, capital: string, cost: string): Metric {
  const q = s.exitBasis;
  if (!q || !validNumber(q.grossB) || !q.source || !Number.isFinite(Date.parse(q.quotedAt)) || Date.parse(q.quotedAt) > Date.parse(s.asOf) || (s.freshness !== "demo" && (q.kind !== "quote" || !q.expiresAt || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= Date.parse(s.asOf)))) return unavailable("Exit basis missing, not quoted or stale; no par conversion assumed");
  if (q.route === "retain-tokens") {
    if (!q.tokens || !validNumber(q.tokens.a) || !validNumber(q.tokens.b)) return unavailable("Exit token basket missing");
    return available(new D(q.tokens.a).mul(s.path.at(-1)!.priceBPerA).add(q.tokens.b).sub(capital).sub(cost));
  }
  return available(new D(q.grossB).sub(capital).sub(cost));
}
// Fees accrue under the PREVIOUS range at each sampled endpoint. Then a trigger may
// pay its operation cost from LP principal and recenter. Earned fees remain isolated B.
// This is a deterministic sampled path policy, never unattended transaction execution.
export function evaluateScenario(s: Scenario, capital: string, mode: "existing" | "new" = "existing"): StrategyResult[] {
  const invalid = !Number.isFinite(Date.parse(s.asOf)) || s.freshness === "stale" || s.freshness === "missing" || !s.path.length || !validNumber(capital) || new D(capital).lte(0) || !validNumber(s.feeRate) || new D(s.feeRate).gt(1) || !validRange(s.lower,s.upper) ||
    s.path.some((p,i) => !Number.isFinite(p.day) || p.day < 0 || (i === 0 ? p.day !== 0 : p.day <= s.path[i-1]!.day) || !validNumber(p.priceBPerA) || new D(p.priceBPerA).lte(0) || !validNumber(p.volumeB) || !validNumber(p.activeLiquidity) || new D(p.activeLiquidity).lte(0));
  const rows = (["hold", "rerange", "exit"] as const).map(strategy => {
    const rebalances: RebalanceEvent[] = []; let breakevenDay: number | null = null;
    const costs = costTotal(s.costs[strategy]); let net: Metric = costs;
    if (strategy === "exit" && mode === "new") net = available(new D(0));
    else if (invalid || s.risks.length) net = unavailable("Invalid/stale/missing path data or risk threshold triggered", ...s.risks);
    else if (costs.value !== null) {
      if (strategy === "exit") net = exitResult(s,capital,costs.value);
      else if (strategy === "rerange" && !validPolicy(s.rerangePolicy)) net = unavailable("Conditional rerange policy missing or invalid");
      else {
        let lower = new D(s.lower), upper = new D(s.upper);
        let liquidity = new D(capital).div(unitValue(new D(s.path[0]!.priceBPerA),lower,upper));
        let fees = new D(0); let lastRebalance = -Infinity;
        for (const [index,p] of s.path.entries()) {
          const price = new D(p.priceBPerA);
          if (index > 0 && price.gt(lower) && price.lt(upper)) fees = fees.add(new D(p.volumeB).mul(s.feeRate).mul(liquidity.div(new D(p.activeLiquidity).add(liquidity))));
          let principal = index === 0 ? new D(capital) : unitValue(price,lower,upper).mul(liquidity);
          const policy = s.rerangePolicy;
          const triggered = policy && (policy.trigger.kind === "outside-range" ? price.lte(lower) || price.gte(upper) : policy.trigger.direction === "below" ? price.lte(policy.trigger.price) : price.gte(policy.trigger.price));
          if (strategy === "rerange" && index > 0 && policy && triggered && rebalances.length < policy.maxRebalances && (lastRebalance === -Infinity || new D(p.day).sub(lastRebalance).gte(policy.cooldownDays))) {
            const operation = costTotal(policy.costsPerRebalance);
            if (operation.value === null) { net = operation; breakevenDay = null; break; }
            if (principal.lte(operation.value)) { net = unavailable("Insufficient principal for conditional rerange cost"); breakevenDay = null; break; }
            principal = principal.sub(operation.value);
            lower = price.mul(policy.lowerFactor); upper = price.mul(policy.upperFactor);
            liquidity = principal.div(unitValue(price,lower,upper)); lastRebalance = p.day;
            rebalances.push({day:p.day,price:price.toFixed(),lower:lower.toFixed(),upper:upper.toFixed(),cost:operation.value});
          }
          const value = principal.add(fees).sub(capital).sub(costs.value);
          if (value.gte(0) && breakevenDay === null) breakevenDay = p.day;
          net = available(value);
        }
      }
    }
    return { strategy, net, rebalances, breakevenDay, breakevenReason: strategy === "exit" && mode === "new" ? "No deposit has been made; there is no breakeven period." : net.status === "unavailable" ? "Data or risk limits prevent a reliable estimate." : breakevenDay === null ? "Breakeven was not reached within the estimated period." : "The first estimated point at which costs are covered under the specified price path, volume, liquidity and costs; this is not a guaranteed breakeven date.", deltaVsHold: unavailable("Hold comparison pending") };
  });
  for (const row of rows) row.deltaVsHold = excessNet(row.net,rows[0]!.net);
  return rows;
}
