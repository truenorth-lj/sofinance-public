/**
 * Concentrated-liquidity maths for sizing a position (pure, float based; this is an estimate, not
 * an on-chain amount calculation). All values are RAW token units and sqrt prices of RAW price.
 *
 * For liquidity L in [sa, sb] at sqrt price s:
 *   s <= sa : only A,  a = L * (1/sa - 1/sb),             b = 0
 *   s >= sb : only B,  a = 0,                              b = L * (sb - sa)
 *   inside  : a = L * (1/s - 1/sb),                        b = L * (s - sa)
 * Value in B-raw is a * s^2 + b (raw price = s^2), converted to USD with `usdPerRawB`.
 */
export type PositionTokenAmountsPerLiquidity = { a: number; b: number };

export function amountsPerLiquidity(sqrtCurrent: number, sqrtLower: number, sqrtUpper: number): PositionTokenAmountsPerLiquidity {
  if (!(sqrtLower > 0) || !(sqrtUpper > sqrtLower) || !(sqrtCurrent > 0)) {
    throw new Error("Invalid sqrt price bounds");
  }
  if (sqrtCurrent <= sqrtLower) return { a: 1 / sqrtLower - 1 / sqrtUpper, b: 0 };
  if (sqrtCurrent >= sqrtUpper) return { a: 0, b: sqrtUpper - sqrtLower };
  return { a: 1 / sqrtCurrent - 1 / sqrtUpper, b: sqrtCurrent - sqrtLower };
}

/** USD value of one unit of liquidity in the given range at the current price. */
export function usdPerLiquidity(
  sqrtCurrent: number, sqrtLower: number, sqrtUpper: number, usdPerRawB: number,
): number {
  const { a, b } = amountsPerLiquidity(sqrtCurrent, sqrtLower, sqrtUpper);
  return (a * sqrtCurrent * sqrtCurrent + b) * usdPerRawB;
}

/** Liquidity bought by `capitalUsd` in the range (0 when inputs are not usable). */
export function liquidityForCapital(
  capitalUsd: number, sqrtCurrent: number, sqrtLower: number, sqrtUpper: number, usdPerRawB: number,
): number {
  if (!(capitalUsd > 0) || !(usdPerRawB > 0)) return 0;
  const perLiquidity = usdPerLiquidity(sqrtCurrent, sqrtLower, sqrtUpper, usdPerRawB);
  return perLiquidity > 0 ? capitalUsd / perLiquidity : 0;
}
