import BN from "bn.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";

/**
 * The tick-spacing band that holds `tickCurrent`: [floor(tick / spacing) * spacing, + spacing).
 * Raydium CLMM only initializes ticks on multiples of `tickSpacing`, so active liquidity cannot
 * change while the price stays inside this band.
 */
export function tickSpacingBand(tickCurrent: number, tickSpacing: number): { lower: number; upper: number } {
  if (!Number.isInteger(tickCurrent) || !Number.isInteger(tickSpacing) || tickSpacing <= 0) {
    throw new Error("Invalid pool tick or tick spacing");
  }
  const lower = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
  return { lower, upper: lower + tickSpacing };
}

/**
 * True when a constant-liquidity projection from `startSqrtX64` to `projectedSqrtX64` is exact: the
 * projected price is unchanged, or stays inside the current tick-spacing band (lower edge inclusive,
 * upper edge exclusive). Leaving the band may cross an initialized tick where liquidity changes.
 */
export function staysInLiquidityBand(
  startSqrtX64: BN | string, projectedSqrtX64: BN | string, tickCurrent: number, tickSpacing: number,
): boolean {
  const start = new BN(startSqrtX64.toString());
  const projected = new BN(projectedSqrtX64.toString());
  if (projected.eq(start)) return true;
  const { lower, upper } = tickSpacingBand(tickCurrent, tickSpacing);
  return projected.gte(TickUtil.getSqrtPriceAtTick(lower)) && projected.lt(TickUtil.getSqrtPriceAtTick(upper));
}

export const CROSS_LIQUIDITY_BAND_MESSAGE =
  "Swap may move the pool price past a tick-spacing boundary where liquidity can change; cross-tick depth estimation not currently supported";
