import Decimal from "decimal.js";
import type { AprWindowAverage } from "./lp-plan-best-apr";
import { isThinPlanSample, type PlanYieldComparison } from "./lp-plan-yield";

const D = Decimal.clone({ precision: 60 });

/**
 * The share view counts a same-stock position per 100 shares held: hold stays at 100, the position ends at
 * 100 × (1 + gain). For a same-stock pair both tokens are the same stock, so fees collected on either side add
 * to one share count, and the per-100 framing needs no stock price.
 */
export const PLAN_SHARE_BASIS = 100;

/** Pairs whose two sides are stablecoins (the curated USDC/USDT pool) have no stock to count in shares. */
const STABLE_SYMBOLS = new Set(["USDC", "USDT", "PYUSD", "USDG", "USDS", "USD1"]);

/**
 * The stock symbol the share view counts in (`SPCX` for SPCXx/SPCX), or null when the pair is not a same-stock
 * pair (both sides stablecoins, or a side is missing).
 */
export function planShareSymbol(pair: { wrappedSymbol?: string; plainSymbol?: string } | null | undefined): string | null {
  const wrapped = pair?.wrappedSymbol?.trim().toUpperCase() ?? "";
  const plain = pair?.plainSymbol?.trim() ?? "";
  if (!wrapped || !plain) return null;
  if (STABLE_SYMBOLS.has(wrapped) && STABLE_SYMBOLS.has(plain.toUpperCase())) return null;
  return plain;
}

/** `SPCXx/SPCX` → its two symbols (wrapped first, as the pool list labels them); null for anything else. */
export function pairLabelSymbols(label: string | null | undefined): { wrappedSymbol: string; plainSymbol: string } | null {
  const [wrappedSymbol, plainSymbol, extra] = (label ?? "").split("/");
  return wrappedSymbol && plainSymbol && extra === undefined ? { wrappedSymbol, plainSymbol } : null;
}

/** A USDC profit or loss as a change in shares per `PLAN_SHARE_BASIS` held (profit ÷ capital × 100). */
export function profitToShareDelta(profit: string, capital: string): string {
  const cap = new D(capital);
  if (!cap.isFinite() || cap.lte(0)) throw new Error("capital must be greater than zero");
  return new D(profit).div(cap).mul(PLAN_SHARE_BASIS).toFixed();
}

/**
 * The lowest trailing-window average that competes with the best one (same rule as `selectBestPlanApr`: thin
 * windows only count when no window is well sampled). Returns null when it equals the best, so there is no range.
 */
export function lowPlanApr(
  best: AprWindowAverage,
  windows: readonly AprWindowAverage[],
): AprWindowAverage | null {
  const reliable = windows.filter((window) => !isThinPlanSample(window.sampleDays));
  const contenders = reliable.length > 0 ? reliable : windows;
  if (contenders.length === 0) return null;
  const low = contenders.reduce((min, next) => (new D(next.aprPct).lt(min.aprPct) ? next : min));
  return new D(low.aprPct).lt(best.aprPct) ? low : null;
}

/** End of the period in shares per 100 held, e.g. "110.78". */
export function endShares(comparison: Pick<PlanYieldComparison, "endSofinance" | "capital">): string {
  return new D(PLAN_SHARE_BASIS).add(profitToShareDelta(comparison.endSofinance, comparison.capital)).toFixed();
}
