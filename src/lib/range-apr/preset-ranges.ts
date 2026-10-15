import "@/lib/engine-host";
import "server-only";

import BN from "bn.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { resolveOpenRange } from "@sofinance/engine/open-range";
import type { RangeAprPresetId } from "./types";

/** Display order: Micro first, then the percent presets, narrow to wide (the canonical candidate order). */
export const RANGE_APR_PRESET_ORDER: readonly RangeAprPresetId[] = ["micro", "tight", "standard", "wide"];

export type PresetTickRange = {
  id: RangeAprPresetId; tickLower: number; tickUpper: number; priceLower: number; priceUpper: number;
};

/**
 * Resolves every preset with the SAME function the quote/prepare path uses (`resolveOpenRange`), so the
 * ticks priced by the estimate are exactly the ticks the position would be opened with.
 */
export function resolvePresetRanges(pool: {
  tickCurrent: number; sqrtPriceX64: string; decimalsA: number; decimalsB: number; tickSpacing: number;
}): PresetTickRange[] {
  const currentPrice = TickUtil.sqrtPriceX64ToPrice(
    new BN(pool.sqrtPriceX64), pool.decimalsA, pool.decimalsB,
  ).toNumber();
  return RANGE_APR_PRESET_ORDER.map((id) => {
    const resolved = resolveOpenRange({
      range: { preset: id }, currentPrice, tickCurrent: pool.tickCurrent, sqrtPriceX64: pool.sqrtPriceX64,
      decimalsA: pool.decimalsA, decimalsB: pool.decimalsB, tickSpacing: pool.tickSpacing,
    });
    return {
      id, tickLower: resolved.tickLower, tickUpper: resolved.tickUpper,
      priceLower: resolved.priceLower, priceUpper: resolved.priceUpper,
    };
  });
}
