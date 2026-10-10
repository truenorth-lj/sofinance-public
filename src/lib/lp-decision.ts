import type { DecisionObservations } from "./lp-decision-data";
import Decimal from "decimal.js";
import { atomicUnits, unavailable, type Cost, type DecisionRequest, type Metric, DECISION_VERSION } from "./lp-accounting";
import { evaluateScenario, type Scenario, type StrategyResult } from "./lp-scenario";
export * from "./lp-accounting";
export * from "./lp-scenario";
const D = Decimal.clone({ precision: 120 });
export type DecisionResponse = {
  requestId: string; contextVersion: number; asOf: string; version: string; demo: boolean;
  numeraire: "USDC"; mode: "existing" | "new"; status: "scenario" | "partial" | "unavailable"; observations?: DecisionObservations;
  sources: Array<{ source: string; asOf: string; status: "demo" | "missing" | "fresh" | "stale" }>;
  historical: Metric; hodlExcess: Metric; exit: Metric;
  probability: null; probabilityGate: string[]; warnings: string[]; executable: false;
  scenarios: Array<{ id: string; label: string; probability: null; assumptions: Scenario; strategies: StrategyResult[] }>;
};
export function buildDecision(req: DecisionRequest, now = new Date().toISOString()): DecisionResponse {
  const durationMs = Date.parse(req.targetDate) - Date.parse(now);
  const daysExact = new D(durationMs).div(86400000);
  const days = daysExact.toNumber();
  if (!Number.isFinite(durationMs) || days <= 0 || days > 365) throw new Error("The target date must be within the next 1–365 days (UTC).");
  const missing = unavailable("Event-time prices, complete costs, asset attribution and position reconciliation are unavailable.");
  const result: DecisionResponse = {
    requestId: req.requestId, contextVersion: req.contextVersion, asOf: now, version: DECISION_VERSION,
    demo: req.demo, numeraire: "USDC", mode: req.positionId ? "existing" : "new", status: req.demo ? "scenario" : "unavailable",
    sources: [{ source: req.demo ? "Synthetic CLMM path fixture / USDC numeraire; no USD peg assumption" : "No verified decision data adapter configured", asOf: now, status: req.demo ? "demo" : "missing" }],
    historical: missing, hodlExcess: missing, exit: unavailable("An executable exit route, current quotes and complete costs are unavailable."),
    probability: null, probabilityGate: ["Pool-specific historical windows and a complete set of mutually exclusive scenarios are unavailable.", "Time-split out-of-sample validation, leakage checks and calibration thresholds are incomplete."],
    warnings: ["Read-only analysis; transactions are not signed, prepared or submitted.", "The arbitrage revenue mechanism is unverified; additional arbitrage income is excluded.", ...(req.demo ? ["DEMO: synthetic paths and costs, without actual data from the selected pool or position. This is not position reconciliation or trading advice."] : ["Insufficient data: displayed APR and existing pnlUsd are not substitutes for net returns."])], executable: false, scenarios: [],
  };
  if (!req.demo) return result;
  const costs = (prefix: string, network: string): Cost[] => (["network", "priority", "dex", "price-impact", "platform", "rent", "other"] as const).map(category => ({ id: `${prefix}-${category}`, category, value: category === "network" ? network : "0", included: false, source: "demo synthetic assumption", timestamp: now, period: "future" }));
  for (const [id,label,end,volume] of ([["flat","Flat price / trading volume","1","10000"],["loss","Price decline / out of range","0.7","1000"],["tail","Price gap / no trading volume","0.3","0"]] as const)) {
    const scenario: Scenario = { freshness: "demo", id, label, path: [{ day: 0, priceBPerA: "1", volumeB: "0", activeLiquidity: "1000000" }, { day: days, priceBPerA: end, volumeB: new D(volume).mul(daysExact).toFixed(), activeLiquidity: "1000000" }], feeRate: "0.003", lower: "0.8", upper: "1.2", costs: { hold: costs("hold", "2"), rerange: costs("rerange", "2"), exit: costs("exit", "1") }, exitBasis: { kind: "demo", route: "convert", grossB: atomicUnits(req.amountAtomic, req.decimals).toFixed(), source: "Explicit demo par conversion, not an executable quote", quotedAt: now, expiresAt: null },
      rerangePolicy: { trigger: { kind: "outside-range" }, lowerFactor: "0.9", upperFactor: "1.1", cooldownDays: 1, maxRebalances: 3, costsPerRebalance: costs("rerange-operation", "6") },
      source: "demo sampled path; end-point fee quadrature, rerange only after trigger; no continuous path claim", asOf: now, risks: [] };
    const rows = evaluateScenario(scenario, atomicUnits(req.amountAtomic, req.decimals).toFixed(), req.positionId ? "existing" : "new");
    if (!req.positionId) scenario.costs.exit = costs("not-invested", "0");
    result.scenarios.push({ id, label, probability: null, assumptions: scenario, strategies: rows });
  }
  return result;
}
