/** Ticks that will be signed for an RHC open. Always centered on the current on-chain tick. */
export type RhcOpenTickPool = {
  tick: number | null;
  token0: { symbol: string; decimals: number };
  token1: { symbol: string; decimals: number };
};

export function rhcDefaultOpenTicks(
  pool: RhcOpenTickPool,
  halfWidth: number,
): { tickLower: number; tickUpper: number; center: number } | null {
  if (pool.tick === null) return null;
  const center = pool.tick;
  return { center, tickLower: center - halfWidth, tickUpper: center + halfWidth };
}

/** Uniswap v4: in range when tickLower <= current < tickUpper. */
export function rhcRangeSide(tick: number, tickLower: number, tickUpper: number): "below" | "inside" | "above" {
  if (tick < tickLower) return "below";
  if (tick >= tickUpper) return "above";
  return "inside";
}
