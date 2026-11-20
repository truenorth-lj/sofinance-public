import type { OpenRangeInput } from "./open-range-input";

/** Same 2% gate as the app `fairPriceFor`. */
export const FAIR_CENTER_MAX_RELATIVE_DIFF = 0.02;

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Default open-range center, as raw token-B per token-A.
 * Uses multiplierA / multiplierB when both are present and the on-chain price is
 * within 2% of that fair value; otherwise the on-chain price.
 * `onChainPriceBPerA` must come from on-chain sqrtPrice, never from a list/API price.
 */
export function openRangeCenterPrice(input: {
  multiplierA?: number;
  multiplierB?: number;
  onChainPriceBPerA: number;
}): number {
  const { multiplierA, multiplierB, onChainPriceBPerA } = input;
  if (!isPositiveFinite(multiplierA) || !isPositiveFinite(multiplierB) || !isPositiveFinite(onChainPriceBPerA)) {
    return onChainPriceBPerA;
  }
  const fair = multiplierA / multiplierB;
  if (!isPositiveFinite(fair)) return onChainPriceBPerA;
  if (Math.abs(onChainPriceBPerA - fair) / fair > FAIR_CENTER_MAX_RELATIVE_DIFF) return onChainPriceBPerA;
  return fair;
}

/** Apply fair (or on-chain fallback) centering when the user left the fair-center control on. */
export function rangeWithFairCenter(
  range: OpenRangeInput,
  pool: {
    multiplierA?: number;
    multiplierB?: number;
    price: string | number;
  },
): OpenRangeInput {
  if (range.preset === "custom" || !range.centerOnParity) return range;
  const onChainPriceBPerA = Number(pool.price);
  return {
    ...range,
    centerOnParity: true,
    centerPrice: openRangeCenterPrice({
      multiplierA: pool.multiplierA,
      multiplierB: pool.multiplierB,
      onChainPriceBPerA,
    }),
  };
}

/** Inclusive unit/bin band of `units` around `center` (lower = center - floor(units/2)). */
export function unitBand(center: number, units: number): { lower: number; upper: number } {
  const lower = center - Math.floor(units / 2);
  return { lower, upper: lower + units - 1 };
}

/**
 * Center a unit/bin range on the fair unit first. If the current unit is outside that
 * inclusive band, center on the current unit instead.
 */
export function unitCenterWithCurrentFallback(fairCenter: number, current: number, units: number): number {
  const { lower, upper } = unitBand(fairCenter, units);
  return current >= lower && current <= upper ? fairCenter : current;
}

/** Uniswap-style ticks: in range when lower <= current < upper. */
export function tickRangeContainsCurrent(tickLower: number, tickUpper: number, tickCurrent: number): boolean {
  return tickLower <= tickCurrent && tickCurrent < tickUpper;
}
