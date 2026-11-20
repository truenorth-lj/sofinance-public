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
