import type { OpenRangeInput } from "./open-range-input";

/** Same 2% gate as the app `fairPriceFor`. */
export const FAIR_CENTER_MAX_RELATIVE_DIFF = 0.02;

function isPositiveFinite(value: number | undefined | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Default open-range center, as raw token-B per token-A.
 * Prefers `fairPriceBPerA` (the official hSOL stake-pool rate, in the pool's
 * B-per-A units) when present; otherwise multiplierA / multiplierB. Uses that
 * fair value only when the on-chain price is within 2% of it; otherwise the
 * on-chain price. `onChainPriceBPerA` must come from on-chain sqrtPrice / the
 * active bin, never from a list/API price.
 */
export function openRangeCenterPrice(input: {
  multiplierA?: number;
  multiplierB?: number;
  /** Official fair price in token-B-per-token-A units, when known (LST rate). */
  fairPriceBPerA?: number;
  onChainPriceBPerA: number;
}): number {
  const { multiplierA, multiplierB, fairPriceBPerA, onChainPriceBPerA } = input;
  if (!isPositiveFinite(onChainPriceBPerA)) return onChainPriceBPerA;
  const fair = isPositiveFinite(fairPriceBPerA)
    ? fairPriceBPerA
    : isPositiveFinite(multiplierA) && isPositiveFinite(multiplierB)
      ? multiplierA / multiplierB
      : null;
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
    fairPriceBPerA?: number;
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
      fairPriceBPerA: pool.fairPriceBPerA,
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
