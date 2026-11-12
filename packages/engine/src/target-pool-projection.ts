import BN from "bn.js";
import { SqrtPriceMath } from "@raydium-io/raydium-sdk-v2";
import { staysInLiquidityBand } from "./liquidity-band";
import { positionSide } from "./quote-math";

/**
 * The swap legs of one open-position strategy would move the target pool's price
 * in a way the pre-add estimate cannot accept (out of the selected range, across
 * the active tick, or a route too complex to estimate). The sequential
 * strategies deliberately route the second hop through the target pool, so this
 * is strategy-specific: another strategy whose legs avoid the target pool can
 * still pass the same guard. Kept in its own module so callers can classify it
 * even where `open-quote` is mocked.
 */
export class TargetPoolProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetPoolProjectionError";
  }
}

export type TargetPoolProjectionRoute = {
  routePlan: {
    bps: number;
    swapInfo: { ammKey: string; inputMint: string; outputMint: string; inAmount: string };
  }[];
};

export type ProjectTargetPoolSqrtInput = {
  poolId: string;
  mintA: string;
  mintB: string;
  sqrtPriceX64: string;
  poolLiquidity: string;
  tickCurrent: number;
  tickSpacing: number;
  lowerSqrtX64: string;
  upperSqrtX64: string;
  rangeSide: "below" | "inside" | "above";
  routes: TargetPoolProjectionRoute[];
  /** Thrown when the target pool is used more than once or not as a 100% hop. */
  complexError: () => Error;
  /** Thrown when the projected price leaves the selected / position range. */
  rangeError: () => Error;
  /** Thrown when the projected price leaves the current tick-spacing liquidity band. */
  bandError: () => Error;
};

/**
 * Conservatively project the pool price after any hops that go through `poolId`.
 * Callers supply their own errors so open ("pre-open", TargetPoolProjectionError) and
 * selected ("pre-add", PoolPriceMoveError) messages stay distinct.
 */
export function projectTargetPoolSqrt(input: ProjectTargetPoolSqrtInput): BN {
  let price = new BN(input.sqrtPriceX64);
  const liquidity = new BN(input.poolLiquidity);
  let targetHops = 0;
  for (const route of input.routes) for (const leg of route.routePlan) {
    if (leg.swapInfo.ammKey !== input.poolId) continue;
    targetHops++;
    if (targetHops > 1 || leg.bps !== 10_000) throw input.complexError();
    const zeroForOne = leg.swapInfo.inputMint === input.mintA && leg.swapInfo.outputMint === input.mintB;
    const oneForZero = leg.swapInfo.inputMint === input.mintB && leg.swapInfo.outputMint === input.mintA;
    if (!zeroForOne && !oneForZero) throw new Error("Target pool route asset mismatch");
    price = SqrtPriceMath.getNextSqrtPriceFromInput(price, liquidity, new BN(leg.swapInfo.inAmount), zeroForOne);
  }
  if (positionSide(BigInt(price.toString()), BigInt(input.lowerSqrtX64), BigInt(input.upperSqrtX64)) !== input.rangeSide) {
    throw input.rangeError();
  }
  if (!staysInLiquidityBand(input.sqrtPriceX64, price, input.tickCurrent, input.tickSpacing)) {
    throw input.bandError();
  }
  return price;
}
