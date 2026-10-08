import { DEFAULT_COMPOUND_ADD_TOLERANCE_BPS } from "./ids";
import { toleranceLiquidity } from "./quote-math";

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

/** Reduce the swap-output side to minOut so add sizing matches the on-chain floor. */
export function conservativeSwapBalances(input: {
  endingA: bigint; endingB: bigint; mintA: string; mintB: string;
  swap?: { outputMint: string; quotedOutputAmount: string; minOutputAmount: string; simulatedOutputAmount?: string } | null;
}) {
  const swap = input.swap;
  if (!swap) return { a: input.endingA, b: input.endingB };
  const simulated = BigInt(swap.simulatedOutputAmount ?? swap.quotedOutputAmount);
  const minOut = BigInt(swap.minOutputAmount);
  if (minOut > simulated) throw new Error("Compound swap minimum exceeds simulated output");
  const haircut = simulated - minOut;
  if (swap.outputMint === input.mintA) {
    if (haircut > input.endingA) throw new Error("Conservative swap output exceeds simulated balance");
    return { a: input.endingA - haircut, b: input.endingB };
  }
  if (swap.outputMint === input.mintB) {
    if (haircut > input.endingB) throw new Error("Conservative swap output exceeds simulated balance");
    return { a: input.endingA, b: input.endingB - haircut };
  }
  return { a: input.endingA, b: input.endingB };
}

/**
 * Size below the exact harvested/swapped balances by the add-liquidity tolerance
 * so a small pool-price move cannot trip Raydium PriceSlippageCheck (6017).
 * amountMax is the required amount padded by the same tolerance, never above the
 * conservative available balances. Leftovers stay in the yield accounts.
 */
export function sizeBufferedCompoundLiquidity(
  price: bigint, lower: bigint, upper: bigint, a: bigint, b: bigint,
  startingLiquidity = 0n, toleranceBps = DEFAULT_COMPOUND_ADD_TOLERANCE_BPS,
) {
  const full = sizeCompoundLiquidity(price, lower, upper, a, b, startingLiquidity);
  let liquidity = toleranceLiquidity(full.liquidity, toleranceBps);
  if (liquidity === 0n && full.liquidity > 0n) {
    const one = amountsForCompoundLiquidity(price, lower, upper, 1n);
    liquidity = one.a <= a && one.b <= b ? 1n : 0n;
  }
  const required = amountsForCompoundLiquidity(price, lower, upper, liquidity);
  // Isolated yield leftovers are intended for this add. Cap at the conservative
  // (min-out) balances so a price move can consume the haircut, not more.
  return {
    liquidity,
    a: required.a,
    b: required.b,
    amountMaxA: a,
    amountMaxB: b,
  };
}
