import { FAIR_CENTER_MAX_RELATIVE_DIFF } from "../open-range-center";
import type { Asset } from "./asset";
import type { PriceQuote, ValuationQuote } from "./types";

/** Same 2% gate as the open-range center and the app `fairPriceFor` (PM decision Q1, 2026-11-21). */
export const PAIR_GUARD_MAX_RELATIVE_DIFF = FAIR_CENTER_MAX_RELATIVE_DIFF;

export type PairSide = "a" | "b";

/**
 * Cross-check of the two USD prices against the pool's own price. `relativeDiff` = |pA − r·pB| / (r·pB), where pA and pB
 * are USD per raw unit and r is the pool's B per A in raw units. Over the gate one side is suspect and is replaced by the
 * price implied by the other side and the pool:
 * - `multiplier`: only one side has a multiplier other than 1, so that side's per-share price is the likelier mistake;
 * - `liquidity`: otherwise the side with less Jupiter liquidity (a missing liquidity counts as none).
 * `unresolved`: over the gate but neither rule picks a side; both own prices are kept.
 */
export type PairGuard =
  | { kind: "not-checked"; reason: "no-multiplier" | "missing-price" | "no-pool-price" }
  | { kind: "agreed"; relativeDiff: number }
  | { kind: "corrected"; relativeDiff: number; side: PairSide; rule: "multiplier" | "liquidity"; ownUsdPerRawUnit: number }
  | { kind: "unresolved"; relativeDiff: number };

/** One side's price. `usdPerRawUnit` is the only figure to multiply raw / 10^decimals by. Plain data. */
export type SidePricing = {
  usdPerRawUnit: number | null;
  /** USD per share (scaled UI unit): `usdPerRawUnit / multiplier`. */
  sharePriceUsd: number | null;
  /** Effective multiplier at evaluation time; null when unknown (never treated as 1). */
  multiplier: number | null;
  /** Unit of the quote this side was priced from; null without a quote. */
  basis: ValuationQuote["basis"] | null;
};

export type PairPricing = { a: SidePricing; b: SidePricing; guard: PairGuard };

type PairSideInput = { asset: Asset; quote: PriceQuote | null };

const positive = (value: number | null | undefined): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

function sideOf({ asset, quote }: PairSideInput, nowMs: number): SidePricing {
  const multiplier = asset.multiplierAt(nowMs);
  const usdPerRawUnit = quote ? asset.usdPerRawUnit(quote, nowMs) : null;
  return { usdPerRawUnit, sharePriceUsd: sharePrice(usdPerRawUnit, multiplier), multiplier, basis: quote?.basis ?? null };
}

const sharePrice = (usdPerRawUnit: number | null, multiplier: number | null): number | null =>
  usdPerRawUnit !== null && positive(multiplier) ? usdPerRawUnit / multiplier : null;

function suspectSide(a: PairSideInput & { pricing: SidePricing }, b: PairSideInput & { pricing: SidePricing }):
  { side: PairSide; rule: "multiplier" | "liquidity" } | null {
  const multiplierA = a.pricing.multiplier;
  const multiplierB = b.pricing.multiplier;
  // Unknown does not participate in the multiplier rule. Only known positive, non-1 values count as scaled.
  if (positive(multiplierA) && positive(multiplierB)) {
    const scaledA = multiplierA !== 1;
    const scaledB = multiplierB !== 1;
    if (scaledA !== scaledB) return { side: scaledA ? "a" : "b", rule: "multiplier" };
  }
  const liquidityA = a.quote?.liquidityUsd ?? 0;
  const liquidityB = b.quote?.liquidityUsd ?? 0;
  if (liquidityA === liquidityB) return null;
  return { side: liquidityA < liquidityB ? "a" : "b", rule: "liquidity" };
}

/**
 * Prices both sides of a pool position. Each side goes through its asset (the multiplier is applied only to per-share
 * quotes). The pair guard runs only if at least one asset's multiplierSource is token2022-scaled-ui; ordinary pools
 * always return not-checked / no-multiplier. No I/O.
 */
export function pricePair(input: {
  a: PairSideInput;
  b: PairSideInput;
  /** Pool price as token B per token A in raw units (decimals applied, no multiplier); null skips the guard. */
  poolPriceBPerA: number | null;
  nowMs: number;
  maxRelativeDiff?: number;
}): PairPricing {
  const a = { ...input.a, pricing: sideOf(input.a, input.nowMs) };
  const b = { ...input.b, pricing: sideOf(input.b, input.nowMs) };
  // Ordinary pools never use the pair guard, even if their prices disagree or the pool price is missing.
  if (![input.a.asset, input.b.asset].some((asset) => asset.facts.multiplierSource === "token2022-scaled-ui")) {
    return { a: a.pricing, b: b.pricing, guard: { kind: "not-checked", reason: "no-multiplier" } };
  }
  const pA = a.pricing.usdPerRawUnit;
  const pB = b.pricing.usdPerRawUnit;
  if (pA === null || pB === null) return { a: a.pricing, b: b.pricing, guard: { kind: "not-checked", reason: "missing-price" } };
  const r = input.poolPriceBPerA;
  if (!positive(r)) return { a: a.pricing, b: b.pricing, guard: { kind: "not-checked", reason: "no-pool-price" } };
  const impliedA = r * pB;
  const relativeDiff = Math.abs(pA - impliedA) / impliedA;
  if (relativeDiff <= (input.maxRelativeDiff ?? PAIR_GUARD_MAX_RELATIVE_DIFF)) {
    return { a: a.pricing, b: b.pricing, guard: { kind: "agreed", relativeDiff } };
  }
  const suspect = suspectSide(a, b);
  if (!suspect) return { a: a.pricing, b: b.pricing, guard: { kind: "unresolved", relativeDiff } };
  const replaced = (pricing: SidePricing, usdPerRawUnit: number): SidePricing =>
    ({ ...pricing, usdPerRawUnit, sharePriceUsd: sharePrice(usdPerRawUnit, pricing.multiplier) });
  const guard: PairGuard = { kind: "corrected", relativeDiff, ...suspect, ownUsdPerRawUnit: suspect.side === "a" ? pA : pB };
  return suspect.side === "a"
    ? { a: replaced(a.pricing, impliedA), b: b.pricing, guard }
    : { a: a.pricing, b: replaced(b.pricing, pA / r), guard };
}

/**
 * One side's own registry price before the pair guard: the guard's recorded `ownUsdPerRawUnit` when it corrected this
 * side, else the side's price as reported. Single-asset displays (the stock view) use it; they have no pair to check.
 */
export function ownUsdPerRawUnit(input: { usdPerRawUnit: number | null; side: PairSide; guard: PairGuard | null }): number | null {
  return input.guard?.kind === "corrected" && input.guard.side === input.side ? input.guard.ownUsdPerRawUnit : input.usdPerRawUnit;
}

/** Pool price (token B per token A, raw units) from a Q64.64 sqrt price, as Raydium CLMM and Orca Whirlpool store it. */
export function sqrtPriceX64ToPriceBPerA(sqrtPriceX64: bigint | string, decimalsA: number, decimalsB: number): number {
  const ratio = Number(BigInt(sqrtPriceX64)) / 2 ** 64;
  return ratio * ratio * 10 ** (decimalsA - decimalsB);
}
