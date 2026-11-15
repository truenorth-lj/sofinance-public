/**
 * Same-stock LP calculator math (fees collected vs impermanent loss), for a public, wallet-free estimate page.
 *
 * Both pool tokens track the same stock, so the stock's USD move scales the position and a plain hold equally:
 * it is not impermanent loss. Impermanent loss here comes only from the spread between the two tokens, modelled
 * as the pool price p (B per 1 A) moving from 1 to 1 + spreadMove. Concentrated-liquidity amounts follow the
 * Uniswap v3 formulas on a continuous range [1 - halfWidth, 1 + halfWidth]; no tick alignment.
 *
 * Everything is an estimate: the fee APR input is a recent-window figure (e.g. 7 days) and is not guaranteed.
 */

/** SoFinance protocol fee on the swapped part of a deposit or exit: 10 bps. Withdrawing as the two pool tokens is 0. */
export const SOFINANCE_SWAP_FEE_FRACTION = 0.001;

export interface SameStockLpInput {
  /** Deposit value in USD at entry. */
  depositUsd: number;
  /** Range half-width as a fraction of the entry price, e.g. 0.003 for ±0.3%. */
  halfWidth: number;
  /** Fee APR estimate for this range, as a fraction (0.2 = 20%). */
  feeApr: number;
  /** Share of the time the price is in range, 0..1. Fees accrue only in range. */
  inRangeShare: number;
  /** Days held. */
  days: number;
  /** Spread move between the two tokens by exit, as a fraction (0.003 = +0.3%). Must be > -1. */
  spreadMove: number;
  /** Share of the deposit swapped on entry, 0..1 (0.5 when depositing a single token). */
  entrySwappedShare: number;
  /** Swap price impact as a fraction, applied to every swapped amount. */
  swapImpact: number;
  /** Total network fees in USD (refundable account deposits excluded). */
  networkFeesUsd: number;
  /** Share of the exit value converted to a single token, 0..1 (0 = withdraw as the two pool tokens). */
  exitConvertedShare?: number;
}

export interface SameStockLpEstimate {
  positionValueUsd: number;
  holdValueUsd: number;
  impermanentLossUsd: number;
  feesCollectedUsd: number;
  costsUsd: number;
  netVsHoldUsd: number;
  /** Days in range until fees cover impermanent loss plus costs; null when no fees accrue. */
  breakEvenDays: number | null;
  inRange: boolean;
}

interface Range {
  liquidity: number;
  lower: number;
  upper: number;
  holdA: number;
  holdB: number;
}

function assertInput(input: SameStockLpInput): void {
  const fraction = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;
  if (!(Number.isFinite(input.depositUsd) && input.depositUsd > 0)) throw new Error("depositUsd must be > 0");
  if (!(Number.isFinite(input.halfWidth) && input.halfWidth > 0 && input.halfWidth < 1)) throw new Error("halfWidth must be in (0, 1)");
  if (!(Number.isFinite(input.feeApr) && input.feeApr >= 0)) throw new Error("feeApr must be >= 0");
  if (!fraction(input.inRangeShare)) throw new Error("inRangeShare must be in [0, 1]");
  if (!(Number.isFinite(input.days) && input.days >= 0)) throw new Error("days must be >= 0");
  if (!(Number.isFinite(input.spreadMove) && input.spreadMove > -1)) throw new Error("spreadMove must be > -1");
  if (!fraction(input.entrySwappedShare)) throw new Error("entrySwappedShare must be in [0, 1]");
  if (!(Number.isFinite(input.swapImpact) && input.swapImpact >= 0 && input.swapImpact < 1)) throw new Error("swapImpact must be in [0, 1)");
  if (!(Number.isFinite(input.networkFeesUsd) && input.networkFeesUsd >= 0)) throw new Error("networkFeesUsd must be >= 0");
  if (input.exitConvertedShare !== undefined && !fraction(input.exitConvertedShare)) throw new Error("exitConvertedShare must be in [0, 1]");
}

/** Liquidity and entry token amounts for a deposit centred on p0 = 1. */
function openRange(depositUsd: number, halfWidth: number): Range {
  const lower = 1 - halfWidth;
  const upper = 1 + halfWidth;
  const unitA = 1 - 1 / Math.sqrt(upper);
  const unitB = 1 - Math.sqrt(lower);
  const liquidity = depositUsd / (unitA + unitB);
  return { liquidity, lower, upper, holdA: liquidity * unitA, holdB: liquidity * unitB };
}

/** Position value (in entry USD terms) at pool price p, clamped inventory outside the range. */
function valueAt(range: Range, price: number): number {
  const { liquidity: l, lower, upper } = range;
  if (price <= lower) return l * (1 / Math.sqrt(lower) - 1 / Math.sqrt(upper)) * price;
  if (price >= upper) return l * (Math.sqrt(upper) - Math.sqrt(lower));
  return l * (2 * Math.sqrt(price) - Math.sqrt(lower) - price / Math.sqrt(upper));
}

export function estimateSameStockLp(input: SameStockLpInput): SameStockLpEstimate {
  assertInput(input);
  const range = openRange(input.depositUsd, input.halfWidth);
  const price = 1 + input.spreadMove;
  const positionValueUsd = valueAt(range, price);
  const holdValueUsd = range.holdA * price + range.holdB;
  const impermanentLossUsd = Math.max(0, holdValueUsd - positionValueUsd);
  const dailyFeesUsd = (input.depositUsd * input.feeApr * input.inRangeShare) / 365;
  const feesCollectedUsd = dailyFeesUsd * input.days;
  const perSwap = SOFINANCE_SWAP_FEE_FRACTION + input.swapImpact;
  const entryCost = input.depositUsd * input.entrySwappedShare * perSwap;
  const exitCost = positionValueUsd * (input.exitConvertedShare ?? 0) * perSwap;
  const costsUsd = entryCost + exitCost + input.networkFeesUsd;
  const gap = impermanentLossUsd + costsUsd;
  return {
    positionValueUsd,
    holdValueUsd,
    impermanentLossUsd,
    feesCollectedUsd,
    costsUsd,
    netVsHoldUsd: feesCollectedUsd - gap,
    breakEvenDays: gap <= 0 ? 0 : dailyFeesUsd > 0 ? gap / dailyFeesUsd : null,
    inRange: price > range.lower && price < range.upper,
  };
}

/**
 * Largest spread move in one direction (+1 up, -1 down) for which fees over `days` still cover impermanent loss
 * and costs. Returns 0 when costs alone exceed fees, and `maxMove` when even that move is covered.
 */
export function breakEvenSpreadMove(input: Omit<SameStockLpInput, "spreadMove">, direction: 1 | -1, maxMove = 0.5): number {
  const net = (move: number) => estimateSameStockLp({ ...input, spreadMove: direction * move }).netVsHoldUsd;
  if (net(0) < 0) return 0;
  if (net(maxMove) >= 0) return maxMove;
  let low = 0;
  let high = maxMove;
  for (let i = 0; i < 80; i += 1) {
    const mid = (low + high) / 2;
    if (net(mid) >= 0) low = mid;
    else high = mid;
  }
  return low;
}
