import { fairPriceFor } from "./fair-price";
export { rangeWithFairCenter } from "@sofinance/engine/open-range-center";

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
  if (input.multiplierA === undefined || input.multiplierB === undefined) return input.onChainPriceBPerA;
  const fair = fairPriceFor({
    symbolA: input.symbolA ?? "A",
    symbolB: input.symbolB ?? "B",
    multiplierA: input.multiplierA,
    multiplierB: input.multiplierB,
    price: input.onChainPriceBPerA,
  });
  return fair ? fair.fair : input.onChainPriceBPerA;
}

/** Label for the default-on control that recenters the open range. */
export const CENTER_ON_FAIR_LABEL = "Center range on the fair price";
