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
  if (!Number.isFinite(durationMs) || days <= 0 || days > 365) throw new Error("目標日期須在未來 1–365 天內（UTC）");
  const missing = unavailable("缺事件當時價格、完整成本、資產歸屬及真實持倉對帳");
  const result: DecisionResponse = {
    requestId: req.requestId, contextVersion: req.contextVersion, asOf: now, version: DECISION_VERSION,
    demo: req.demo, numeraire: "USDC", mode: req.positionId ? "existing" : "new", status: req.demo ? "scenario" : "unavailable",
    sources: [{ source: req.demo ? "Synthetic CLMM path fixture / USDC numeraire; no USD peg assumption" : "No verified decision data adapter configured", asOf: now, status: req.demo ? "demo" : "missing" }],
    historical: missing, hodlExcess: missing, exit: unavailable("未提供可執行退出路徑、即時報價與完整成本"),
    probability: null, probabilityGate: ["缺池別歷史窗口及互斥完整情境", "未完成時間切分樣本外驗證、洩漏檢查與校準門檻"],
    warnings: ["唯讀分析；不簽名、不準備或送出交易", "套利回流機制未核實，未納入額外套利收入", ...(req.demo ? ["DEMO：合成路徑與成本，未採用帶入池／持倉的實際數據，不能當真實持倉對帳或交易建議"] : ["資料不足：不以面板 APR 或既有 pnlUsd 代替淨收益"])], executable: false, scenarios: [],
  };
  if (!req.demo) return result;
  const costs = (prefix: string, network: string): Cost[] => (["network", "priority", "dex", "price-impact", "platform", "rent", "other"] as const).map(category => ({ id: `${prefix}-${category}`, category, value: category === "network" ? network : "0", included: false, source: "demo synthetic assumption", timestamp: now, period: "future" }));
  for (const [id,label,end,volume] of ([["flat","平價／有成交量","1","10000"],["loss","下跌／離區間","0.7","1000"],["tail","跳空／零成交量","0.3","0"]] as const)) {
    const scenario: Scenario = { freshness: "demo", id, label, path: [{ day: 0, priceBPerA: "1", volumeB: "0", activeLiquidity: "1000000" }, { day: days, priceBPerA: end, volumeB: new D(volume).mul(daysExact).toFixed(), activeLiquidity: "1000000" }], feeRate: "0.003", lower: "0.8", upper: "1.2", costs: { hold: costs("hold", "2"), rerange: costs("rerange", "2"), exit: costs("exit", "1") }, exitBasis: { kind: "demo", route: "convert", grossB: atomicUnits(req.amountAtomic, req.decimals).toFixed(), source: "Explicit demo par conversion, not an executable quote", quotedAt: now, expiresAt: null },
      rerangePolicy: { trigger: { kind: "outside-range" }, lowerFactor: "0.9", upperFactor: "1.1", cooldownDays: 1, maxRebalances: 3, costsPerRebalance: costs("rerange-operation", "6") },
      source: "demo sampled path; end-point fee quadrature, rerange only after trigger; no continuous path claim", asOf: now, risks: [] };
    const rows = evaluateScenario(scenario, atomicUnits(req.amountAtomic, req.decimals).toFixed(), req.positionId ? "existing" : "new");
    if (!req.positionId) scenario.costs.exit = costs("not-invested", "0");
    result.scenarios.push({ id, label, probability: null, assumptions: scenario, strategies: rows });
  }
  return result;
}
