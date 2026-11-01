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

/** The quoted swap would move the pool price past a point where the pool's liquidity can change. */
export const CROSS_LIQUIDITY_BAND_MESSAGE =
  "The swap for this amount would move the pool price past a point where the pool's liquidity changes, so the app " +
  "can't predict the result safely. Try a smaller amount, a wider range, or refresh the quote.";

/** The quoted swap would move the pool price out of the position's own range, so the deposit would no longer fit it. */
export const CROSS_POSITION_RANGE_MESSAGE =
  "The swap for this amount would move the pool price outside this position's price range, so the deposit would no " +
  "longer fit the position. Try a smaller amount, or refresh the quote.";
