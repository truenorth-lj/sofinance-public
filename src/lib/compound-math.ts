const Q64 = 1n << 64n;
const U128 = 1n << 128n;
export const MAX_U64 = (1n << 64n) - 1n;
export const MAX_U128 = U128 - 1n;
export function wrappingSub128(a: bigint, b: bigint) {
  return ((a - b) % U128 + U128) % U128;
}
export function accruedFee(input: {
  tickCurrent: number; tickLower: number; tickUpper: number;
  global: bigint; lowerOutside: bigint; upperOutside: bigint;
  lastInside: bigint; liquidity: bigint; owed: bigint;
}) {
  const below = input.tickCurrent >= input.tickLower ? input.lowerOutside : wrappingSub128(input.global, input.lowerOutside);
  const above = input.tickCurrent < input.tickUpper ? input.upperOutside : wrappingSub128(input.global, input.upperOutside);
  const inside = wrappingSub128(wrappingSub128(input.global, below), above);
  const result = input.owed + input.liquidity * wrappingSub128(inside, input.lastInside) / Q64;
  if (result < 0n || result > MAX_U64) throw new Error("Yield exceeds u64 range");
  return result;
}
function ceilDivide(a: bigint, b: bigint) { return (a + b - 1n) / b; }
export function amountsForCompoundLiquidity(price: bigint, lower: bigint, upper: bigint, liquidity: bigint) {
  if (lower <= 0n || lower >= upper || price <= 0n || liquidity < 0n) throw new Error("Invalid compound price or liquidity");
  const bounded = price < lower ? lower : price > upper ? upper : price;
  return {
    a: bounded === upper ? 0n : ceilDivide(liquidity * Q64 * (upper - bounded), upper * bounded),
    b: bounded === lower ? 0n : ceilDivide(liquidity * (bounded - lower), Q64),
  };
}
/** Exact rounded-up token requirements; no USD, APR or profitability threshold. */
export function sizeCompoundLiquidity(price: bigint, lower: bigint, upper: bigint, a: bigint, b: bigint, startingLiquidity = 0n) {
  if (a < 0n || b < 0n || a > MAX_U64 || b > MAX_U64 || startingLiquidity < 0n || startingLiquidity > MAX_U128) {
    throw new Error("Compound yield or liquidity exceeds range");
  }
  amountsForCompoundLiquidity(price, lower, upper, 0n);
  let low = 0n;
  let high = MAX_U128 - startingLiquidity;
  while (low < high) {
    const candidate = (low + high + 1n) / 2n;
    const amounts = amountsForCompoundLiquidity(price, lower, upper, candidate);
    if (amounts.a <= a && amounts.b <= b) low = candidate;
    else high = candidate - 1n;
  }
  return { liquidity: low, ...amountsForCompoundLiquidity(price, lower, upper, low) };
}
