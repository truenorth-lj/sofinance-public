/** Exact bigint ports of v4-core TickMath / LiquidityAmounts helpers used by the open planner. */

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const MIN_SQRT_PRICE = 4295128739n;
export const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n;
const MAX_UINT256 = (1n << 256n) - 1n;

const RATIOS: readonly [number, bigint][] = [
  [0x2, 0xfff97272373d413259a46990580e213an], [0x4, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8, 0xffe5caca7e10e4e61c3624eaa0941cd0n],
  [0x10, 0xffcb9843d60f6159c9db58835c926644n], [0x20, 0xff973b41fa98c081472e6896dfb254c0n], [0x40, 0xff2ea16466c96a3843ec78b326b52861n],
  [0x80, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200, 0xf987a7253ac413176f2b074cf7815e54n],
  [0x400, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000, 0xd097f3bdfd2022b8845ad8f792aa5825n],
  [0x2000, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000, 0x31be135f97d08fd981231505542fcfa6n],
  [0x10000, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000, 0x5d6af8dedb81196699c329225ee604n], [0x40000, 0x2216e584f5fa1ea926041bedfe98n],
  [0x80000, 0x48a170391f7dc42444e8fa2n],
];

/** TickMath.getSqrtPriceAtTick (Q64.96, rounded up like the contract). */
export function sqrtPriceAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || tick < MIN_TICK || tick > MAX_TICK) throw new RangeError(`tick out of range: ${tick}`);
  const abs = Math.abs(tick);
  let ratio = abs & 1 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 1n << 128n;
  for (const [bit, multiplier] of RATIOS) if (abs & bit) ratio = (ratio * multiplier) >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Liquidity from token0 for [sqrtP, sqrtUpper] (round down). */
export function liquidityFromAmount0(amount0: bigint, sqrtP: bigint, sqrtUpper: bigint): bigint {
  if (sqrtUpper <= sqrtP) return 0n;
  return (amount0 * sqrtP * sqrtUpper) / ((sqrtUpper - sqrtP) * Q96);
}

/** Liquidity from token1 for [sqrtLower, sqrtP] (round down). */
export function liquidityFromAmount1(amount1: bigint, sqrtLower: bigint, sqrtP: bigint): bigint {
  if (sqrtP <= sqrtLower) return 0n;
  return (amount1 * Q96) / (sqrtP - sqrtLower);
}

/** Token amounts a mint of `liquidity` pulls at `sqrtP` (rounded up, as PoolManager settles). */
export function amountsForLiquidity(liquidity: bigint, sqrtP: bigint, sqrtLower: bigint, sqrtUpper: bigint): { amount0: bigint; amount1: bigint } {
  const p = sqrtP < sqrtLower ? sqrtLower : sqrtP > sqrtUpper ? sqrtUpper : sqrtP;
  const amount0 = p < sqrtUpper ? ceilDiv(liquidity * Q96 * (sqrtUpper - p), sqrtUpper * p) : 0n;
  const amount1 = p > sqrtLower ? ceilDiv(liquidity * (p - sqrtLower), Q96) : 0n;
  return { amount0, amount1 };
}
