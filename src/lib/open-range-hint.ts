import type { OpenRangePreset } from "@sofinance/engine/open-range-presets";

/** "A few USDC": small deposits in a Micro/Tight range often fail to settle quotes. */
export const SMALL_OPEN_AMOUNT_USDC = 10;

export const SMALL_AMOUNT_NARROW_RANGE_HINT =
  "Small amounts in a narrow range may not settle. Try Standard or Wide.";

export function isNarrowOpenRangePreset(preset: OpenRangePreset | string): boolean {
  return preset === "micro" || preset === "tight";
}

export function smallAmountNarrowRangeHint(
  amountUsd: number | null | undefined,
  rangePreset: OpenRangePreset | string,
): string | null {
  if (amountUsd === null || amountUsd === undefined || !Number.isFinite(amountUsd) || amountUsd <= 0 || amountUsd > SMALL_OPEN_AMOUNT_USDC) {
    return null;
  }
  if (!isNarrowOpenRangePreset(rangePreset)) return null;
  return SMALL_AMOUNT_NARROW_RANGE_HINT;
}
