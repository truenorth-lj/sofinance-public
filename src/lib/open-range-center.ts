import type { OpenRangeInput } from "@sofinance/engine/open-range";
import { fairPriceFor } from "./fair-price";

/**
 * Default open-range center, as raw token-B per token-A.
 * Uses `fairPriceFor` when it returns a value; otherwise the on-chain price.
 * `onChainPriceBPerA` must come from on-chain sqrtPrice or the active bin, never from a list/API price
 * (Meteora's API price already includes the ScaledUiAmount multiplier).
 */
export function openRangeCenterPrice(input: {
  symbolA?: string;
  symbolB?: string;
  multiplierA?: number;
  multiplierB?: number;
  onChainPriceBPerA: number;
}): number {
  const fair = fairPriceFor({
    symbolA: input.symbolA ?? "A",
    symbolB: input.symbolB ?? "B",
    multiplierA: input.multiplierA,
    multiplierB: input.multiplierB,
    price: input.onChainPriceBPerA,
  });
  return fair ? fair.fair : input.onChainPriceBPerA;
}

/** Apply fair (or on-chain fallback) centering when the user left the fair-center control on. */
export function rangeWithFairCenter(
  range: OpenRangeInput,
  pool: {
    symbolA?: string | null;
    symbolB?: string | null;
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
      symbolA: pool.symbolA ?? undefined,
      symbolB: pool.symbolB ?? undefined,
      multiplierA: pool.multiplierA,
      multiplierB: pool.multiplierB,
      onChainPriceBPerA,
    }),
  };
}

/** Label for the default-on control that recenters the open range. */
export const CENTER_ON_FAIR_LABEL = "Center range on the fair price";
