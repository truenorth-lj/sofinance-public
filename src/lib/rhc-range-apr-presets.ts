import type { PresetTickRange } from "./range-apr/preset-ranges";
import type { RangeAprPresetId } from "./range-apr/types";

/** Q96 → Q64: drop the low 32 bits so the shared Solana tick maths apply unchanged. */
export function sqrtPriceX96ToX64(sqrtPriceX96: bigint): string {
  return (sqrtPriceX96 >> 32n).toString();
}

/** Tick → B-per-A price (token1 per token0). */
function priceFromTick(tick: number, decimals0: number, decimals1: number): number {
  return Math.pow(1.0001, tick) * Math.pow(10, decimals0 - decimals1);
}

/**
 * RHC candidates: ±10 ticks (Micro; the open-flow minimum), Standard ±0.3%, Wide ±1%.
 * Tight (±0.05% ≈ ±5 ticks) is below the PM minimum and is omitted.
 */
export function resolveRhcPresetRanges(pool: {
  tickCurrent: number; decimalsA: number; decimalsB: number; tickSpacing: number;
}): PresetTickRange[] {
  const { tickCurrent: tick, decimalsA, decimalsB, tickSpacing } = pool;
  const snap = (t: number) => Math.round(t / tickSpacing) * tickSpacing;
  const band = (id: RangeAprPresetId, halfTicks: number): PresetTickRange => {
    const tickLower = snap(tick - halfTicks);
    const tickUpper = snap(tick + halfTicks);
    return {
      id, tickLower, tickUpper,
      priceLower: priceFromTick(tickLower, decimalsA, decimalsB),
      priceUpper: priceFromTick(tickUpper, decimalsA, decimalsB),
    };
  };
  return [band("micro", 10), band("standard", 30), band("wide", 100)];
}
