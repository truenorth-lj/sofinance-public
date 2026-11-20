import { exactTickFromUiPrice, uiPriceFromTick } from "@sofinance/engine/range-apr/tick-math";
import { openRangeCenterPrice } from "./open-range-center";

export type RhcOpenTickPool = {
  tick: number | null;
  token0: { symbol: string; decimals: number };
  token1: { symbol: string; decimals: number };
  multiplier0?: number;
  multiplier1?: number;
};

/** Ticks that will be signed for an RHC open. On-chain `pool.tick` is the price source, never an API mid. */
export function rhcDefaultOpenTicks(
  pool: RhcOpenTickPool,
  halfWidth: number,
  centerOnFair: boolean,
): { tickLower: number; tickUpper: number; center: number } | null {
  if (pool.tick === null) return null;
  let center: number;
  if (centerOnFair) {
    const onChainPriceBPerA = uiPriceFromTick(pool.tick, pool.token0.decimals, pool.token1.decimals);
    const centerPrice = openRangeCenterPrice({
      symbolA: pool.token0.symbol,
      symbolB: pool.token1.symbol,
      multiplierA: pool.multiplier0,
      multiplierB: pool.multiplier1,
      onChainPriceBPerA,
    });
    center = Math.round(exactTickFromUiPrice(centerPrice, pool.token0.decimals, pool.token1.decimals));
  } else {
    center = pool.tick;
  }
  return { center, tickLower: center - halfWidth, tickUpper: center + halfWidth };
}

/** Uniswap v4: in range when tickLower <= current < tickUpper. */
export function rhcRangeSide(tick: number, tickLower: number, tickUpper: number): "below" | "inside" | "above" {
  if (tick < tickLower) return "below";
  if (tick >= tickUpper) return "above";
  return "inside";
}
