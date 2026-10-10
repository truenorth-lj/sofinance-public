import Decimal from "decimal.js";
import { z } from "zod";

const D = Decimal.clone({ precision: 120 });
export function validNumber(value: string | null, minimum = "0") {
  try { return value !== null && new D(value).isFinite() && new D(value).gte(minimum); } catch { return false; }
}
export const DECISION_VERSION = "lp-decision/2";
const unsigned = z.string().regex(/^\d+$/).max(80);
export const decisionRequestSchema = z.object({
  requestId: z.string().min(1).max(100), contextVersion: z.number().int().nonnegative(),
  poolId: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  positionId: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/).optional(),
  amountAtomic: unsigned.refine(v => BigInt(v) > 0n),
  asset: z.literal("USDC"), decimals: z.literal(6), numeraire: z.literal("USDC"),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => {
    const d = new Date(v); return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }), demo: z.boolean().default(false),
}).strict();
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type Metric = { status: "available" | "unavailable"; value: string | null; reasons: string[] };
export const unavailable = (...reasons: string[]): Metric => ({ status: "unavailable", value: null, reasons });
export const available = (value: Decimal): Metric => ({ status: "available", value: value.toFixed(), reasons: [] });
export function atomicUnits(value: string, decimals: number) {
  if (value.length > 80 || !/^\d+$/.test(value) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("Invalid atomic units");
  return new D(value).div(new D(10).pow(decimals));
}
export function amountToAtomic(value: string): string {
  if (!/^\d+(\.\d{1,6})?$/.test(value) || value.length > 60) throw new Error("Enter a positive amount with up to six decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const result = BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  if (result <= 0n) throw new Error("The deposit amount must be greater than zero.");
  return result.toString();
}
export type EventKind = "deposit" | "increase" | "decrease" | "withdrawal" | "fee" | "reward" | "compound" | "transfer" | "swap" | "network" | "priority" | "dex" | "platform" | "rent-paid" | "rent-refund";
export type LedgerEvent = {
  id: string; chain: "solana"; signature: string; eventIndex: number; timestamp: string | null; mint: string;
  incomeDisposition?: "distributed" | "reinvested" | "unclaimed";
  amountAtomic: string; decimals: number; kind: EventKind;
  source: string; relatedEventId?: string; account: "position" | "distributed" | "isolated" | "wallet";
  // Only classified external flows affect PnL; internal transfers/compound never create income.
  role: "deposit" | "withdrawal" | "distributed-income" | "cost" | "internal" | "unclassified";
  priceAtEvent: string | null; priceSource: string | null; priceTimestamp: string | null;
  numeraire: string; costAlreadyIncluded: boolean;
};
export type Cost = { id: string; category: "network" | "priority" | "dex" | "price-impact" | "platform" | "rent" | "other"; value: string | null; included: boolean; source: string | null; timestamp: string | null; period: "historical" | "future" };
export function normalizeLedger(events: LedgerEvent[], numeraire: string) {
  const ids = new Set<string>(); const movements = new Set<string>(); const reasons: string[] = [];
  for (const e of events) {
    atomicUnits(e.amountAtomic, e.decimals);
    if (e.role === "unclassified") reasons.push(`Unclassified asset attribution: ${e.id}`);
    if (ids.has(e.id)) reasons.push(`Duplicate event: ${e.id}`);
    ids.add(e.id);
    const movement = `${e.chain}:${e.signature}:${e.eventIndex}:${e.kind}:${e.mint}`;
    if (!Number.isInteger(e.eventIndex) || e.eventIndex < 0) reasons.push(`Missing canonical event index: ${e.id}`);
    if (movements.has(movement)) reasons.push(`Duplicate chain movement: ${e.id}`);
    movements.add(movement);
    if (e.relatedEventId && !events.some(other => other.id === e.relatedEventId)) reasons.push(`Missing linked event: ${e.id}`);
    if (!e.signature || !e.source || (!e.timestamp || !Number.isFinite(Date.parse(e.timestamp))) || e.numeraire !== numeraire) reasons.push(`Missing provenance: ${e.id}`);
    if (e.role !== "internal" && (e.priceAtEvent === null || !e.priceSource || e.priceTimestamp !== e.timestamp)) reasons.push(`Missing event-time price: ${e.id}`);
    if (e.priceAtEvent !== null && (!validNumber(e.priceAtEvent))) reasons.push(`Invalid price: ${e.id}`);
    if ((e.kind === "compound" || e.kind === "transfer" || e.kind === "swap") && e.role !== "internal") reasons.push(`Internal movement classified as income: ${e.id}`);
    if (e.role === "distributed-income" && (e.account !== "distributed" || e.incomeDisposition !== "distributed" || events.some(other => other.relatedEventId === e.id && other.kind === "compound"))) reasons.push(`Income not outside equity: ${e.id}`);
  }
  return { events, complete: reasons.length === 0, reasons, version: DECISION_VERSION };
}
export function historicalNet(events: LedgerEvent[], equity: string | null, numeraire: string, reconciled: boolean, costsComplete: boolean): Metric {
  const ledger = normalizeLedger(events, numeraire);
  const reasons = [...ledger.reasons, ...(!reconciled ? ["Real position reconciliation missing"] : []), ...(!costsComplete ? ["Historical costs incomplete"] : [])];
  if (!validNumber(equity)) reasons.push("Current fair value unavailable");
  if (reasons.length) return unavailable(...reasons);
  let result = new D(equity!);
  for (const e of events) {
    const v = atomicUnits(e.amountAtomic, e.decimals).mul(e.priceAtEvent ?? 0);
    if (e.role === "deposit") result = result.sub(v);
    if (e.role === "withdrawal" || e.role === "distributed-income") result = result.add(v);
    if (e.role === "cost" && !e.costAlreadyIncluded) result = result.sub(v);
  }
  return available(result);
}
// Proportional basket withdrawals at each withdrawal's event-time prices.
export function hodlNet(flows: Array<{ kind: "deposit" | "withdrawal"; time: string; tokens: Record<string, string>; prices: Record<string, string | null> }>, finalPrices: Record<string, string | null>): Metric {
  const basket: Record<string, Decimal> = {}; let deposits = new D(0); let withdrawals = new D(0);
  for (const f of [...flows].sort((a,b) => Date.parse(a.time) - Date.parse(b.time))) {
    if (!Number.isFinite(Date.parse(f.time))) return unavailable("Missing HODL event time");
    let value = new D(0);
    for (const [mint, quantity] of Object.entries(f.tokens)) {
      const price = f.prices[mint];
      if (price === null || price === undefined) return unavailable("Missing HODL event-time price");
      if (!validNumber(quantity) || !validNumber(price)) return unavailable("Invalid HODL flow");
      value = value.add(new D(quantity).mul(price));
      if (f.kind === "deposit") basket[mint] = (basket[mint] ?? new D(0)).add(quantity);
    }
    if (f.kind === "deposit") { deposits = deposits.add(value); continue; }
    let basketValue = new D(0);
    for (const [mint, q] of Object.entries(basket)) {
      if (!validNumber(f.prices[mint] ?? null)) return unavailable("Missing withdrawal basket price");
      basketValue = basketValue.add(q.mul(f.prices[mint]!));
    }
    if (basketValue.lte(0) || value.gt(basketValue)) return unavailable("HODL withdrawal exceeds basket");
    const remaining = new D(1).sub(value.div(basketValue));
    for (const mint of Object.keys(basket)) basket[mint] = basket[mint]!.mul(remaining);
    withdrawals = withdrawals.add(value);
  }
  let equity = new D(0);
  for (const [mint, q] of Object.entries(basket)) {
    if (!validNumber(finalPrices[mint] ?? null)) return unavailable("Missing HODL final price");
    equity = equity.add(q.mul(finalPrices[mint]!));
  }
  return available(equity.add(withdrawals).sub(deposits));
}
export function excessNet(lp: Metric, hodl: Metric): Metric {
  return lp.value === null || hodl.value === null ? unavailable(...lp.reasons, ...hodl.reasons) : available(new D(lp.value).sub(hodl.value));
}
export function costTotal(costs: Cost[]): Metric {
  const future = costs.filter(c => c.period === "future");
  const categories: Cost["category"][] = ["network", "priority", "dex", "price-impact", "platform", "rent", "other"];
  const reasons = categories.filter(k => !future.some(c => c.category === k)).map(k => `Missing ${k} cost`);
  const ids = new Set<string>(); let total = new D(0);
  for (const c of future) {
    if (ids.has(c.id)) reasons.push(`Duplicate cost ${c.id}`); ids.add(c.id);
    if (c.value === null || !c.source || !c.timestamp || !Number.isFinite(Date.parse(c.timestamp))) reasons.push(`Unknown cost ${c.category}`);
    else if (!validNumber(c.value)) reasons.push(`Invalid cost ${c.category}`);
    else if (!c.included) total = total.add(c.value);
  }
  return reasons.length ? unavailable(...reasons) : available(total);
}
export function exitNet(quote: { gross: string; expiresAt: string; source: string; executable: boolean; route: "retain-tokens" | "convert"; costs: Cost[] } | null, now: string): Metric {
  if (!Number.isFinite(Date.parse(now)) || !quote || !validNumber(quote.gross) || !quote.source || !quote.executable || !Number.isFinite(Date.parse(quote.expiresAt)) || Date.parse(quote.expiresAt) <= Date.parse(now)) return unavailable("Exit quote missing, expired or not executable");
  const costs = costTotal(quote.costs);
  return costs.value === null ? costs : available(new D(quote.gross).sub(costs.value));
}
