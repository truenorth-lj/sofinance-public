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
