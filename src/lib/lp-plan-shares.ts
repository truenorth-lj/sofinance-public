import Decimal from "decimal.js";
import type { AprWindowAverage } from "./lp-plan-best-apr";
import { planAprContenders, type PlanYieldComparison } from "./lp-plan-yield";

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

/**
 * The asset the pools calculator counts in (SP-2, asset-denominated): the stock for a same-stock pair (`planShareSymbol`),
 * USDC for a stablecoin pair, or null when the pair is neither (the caller then stays in dollars).
 */
export function planAssetSymbol(pair: { wrappedSymbol?: string; plainSymbol?: string } | null | undefined): string | null {
  const share = planShareSymbol(pair);
  if (share) return share;
  const sides = [pair?.wrappedSymbol, pair?.plainSymbol].map((symbol) => symbol?.trim().toUpperCase() ?? "");
  return sides.every((symbol) => STABLE_SYMBOLS.has(symbol)) ? "USDC" : null;
}

/** Plain symbols of the curated BTC wraps (the calculator counts in the plain side). */
const BTC_WRAP_SYMBOLS: ReadonlySet<string> = new Set(["WBTC", "CBBTC", "BTC"]);

/**
 * Quick amounts and the default for an amount counted in the pool's asset (SP-2), shared by the Calculate dialog and
 * the homepage estimator: shares of the stock (1 / 10 / 100, default 10), or USDC for the stablecoin pool (100 / 1K /
 * 10K, default 1,000).
 */
export function planAssetAmounts(shareSymbol: string | null): { presets: readonly [string, string, string]; defaultAmount: string } {
  // BTC wraps are worth tens of thousands of dollars each: 0.01 / 0.1 / 1 (default 0.1) instead of 1 / 10 / 100.
  if (shareSymbol && BTC_WRAP_SYMBOLS.has(shareSymbol.trim().toUpperCase())) {
    const presets = ["0.01", "0.1", "1"] as const;
    return { presets, defaultAmount: presets[1] };
  }
  const presets = shareSymbol ? (["1", "10", "100"] as const) : (["100", "1000", "10000"] as const);
  return { presets, defaultAmount: presets[1] };
}

/** "1K" for 1000, "10" for 10: a quick-amount button's label. */
export const planAssetPresetLabel = (value: string) => (Number(value) >= 1000 ? `${Number(value) / 1000}K` : value);

/** Largest amount of an asset the calculator accepts. */
const MAX_PLAN_ASSET = new D("1000000000");

/** "12.5" from the calculator's asset input (commas and spaces ignored, up to 9 decimals, above 0); null when invalid. */
export function parsePlanAssetAmount(input: string): string | null {
  const text = input.replace(/[,\s]/g, "");
  if (!/^\d+(\.\d{0,9})?$/.test(text)) return null;
  const value = new D(text);
  return value.gt(0) && value.lte(MAX_PLAN_ASSET) ? value.toFixed() : null;
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
 * The lowest trailing-window average that competes with the best one (same rule as `selectBestPlanApr`,
 * `planAprContenders`: a window counts only with enough days for its own length). Returns null when it equals the best, so there is no range.
 */
export function lowPlanApr(
  best: AprWindowAverage,
  windows: readonly AprWindowAverage[],
): AprWindowAverage | null {
  const contenders = planAprContenders(windows);
  if (contenders.length === 0) return null;
  const low = contenders.reduce((min, next) => (new D(next.aprPct).lt(min.aprPct) ? next : min));
  return new D(low.aprPct).lt(best.aprPct) ? low : null;
}

/** End of the period in shares per 100 held, e.g. "110.78". */
export function endShares(comparison: Pick<PlanYieldComparison, "endSofinance" | "capital">): string {
  return new D(PLAN_SHARE_BASIS).add(profitToShareDelta(comparison.endSofinance, comparison.capital)).toFixed();
}
