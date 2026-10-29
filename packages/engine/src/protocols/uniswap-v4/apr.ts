/**
 * Read-only fee / APR estimates for a Uniswap v4 pool from its own events (design §4.5).
 *
 * - v4 `Swap` events carry the fee actually charged (pips), so the LP fee of each swap is
 *   |amountIn| × fee / 1e6, where amountIn is the side the swapper paid (negative delta).
 * - TVL is rebuilt from every `ModifyLiquidity` of the pool (net liquidity per range, valued at the
 *   current price): PoolManager holds all pools' tokens together, so its balances cannot be used.
 * - Range APR follows the active-liquidity share: a reference position with liquidity ℓ in range
 *   earns fee_i × ℓ / L_i of each swap i whose tick is inside its range (small deposit, no dilution).
 * Values are in token0 units (no USD oracle in PR1). Estimates, not guarantees.
 */

export type SwapSample = { blockNumber: bigint; amount0: bigint; amount1: bigint; liquidity: bigint; tick: number; fee: number };
export type RangeLiquidity = { tickLower: number; tickUpper: number; liquidity: bigint };

/** Net liquidity per (tickLower, tickUpper); closed ranges are dropped. */
export function liquidityByRange(changes: readonly { tickLower: number; tickUpper: number; liquidityDelta: bigint }[]): RangeLiquidity[] {
  const byRange = new Map<string, RangeLiquidity>();
  for (const change of changes) {
    const key = `${change.tickLower}:${change.tickUpper}`;
    const entry = byRange.get(key) ?? { tickLower: change.tickLower, tickUpper: change.tickUpper, liquidity: 0n };
    entry.liquidity += change.liquidityDelta;
    byRange.set(key, entry);
  }
  return [...byRange.values()].filter(range => range.liquidity > 0n).sort((a, b) => a.tickLower - b.tickLower || a.tickUpper - b.tickUpper);
}

const sqrtAtTick = (tick: number) => Math.pow(1.0001, tick / 2);

/** Raw token amounts held by `liquidity` over [tickLower, tickUpper) at sqrt price `sqrtP` (raw units). */
export function amountsForLiquidity(liquidity: number, tickLower: number, tickUpper: number, sqrtP: number): { amount0: number; amount1: number } {
  const sa = sqrtAtTick(tickLower), sb = sqrtAtTick(tickUpper);
  if (sqrtP <= sa) return { amount0: liquidity * (1 / sa - 1 / sb), amount1: 0 };
  if (sqrtP >= sb) return { amount0: 0, amount1: liquidity * (sb - sa) };
  return { amount0: liquidity * (1 / sqrtP - 1 / sb), amount1: liquidity * (sqrtP - sa) };
}

const abs = (value: bigint) => (value < 0n ? -value : value);

/** LP fee of one swap in raw token0 units (token1 fees converted at `price` = raw token1 per raw token0). */
export function swapFeeInToken0(swap: SwapSample, price: number): number {
  // Negative delta = paid by the swapper (input side); v4 takes the fee from the input amount.
  const zeroForOne = swap.amount0 < 0n;
  const amountIn = Number(abs(zeroForOne ? swap.amount0 : swap.amount1));
  const fee = (amountIn * swap.fee) / 1_000_000;
  return zeroForOne ? fee : fee / price;
}

export const RANGE_APR_HALF_WIDTHS = [1, 10, 60] as const;
export const APR_WINDOWS = [{ label: "24h", seconds: 86_400 }, { label: "7d", seconds: 7 * 86_400 }] as const;

export type Univ4AprWindow = {
  label: "24h" | "7d";
  /** Seconds actually covered (shorter than the window while the pool is younger). */
  coveredSeconds: number;
  swapCount: number;
  /** Swap volume (input side) in token0 units. */
  volumeToken0: number;
  feesToken0: number;
  /** Whole-pool LP fee APR: fees / TVL, annualized (simple, no compounding). */
  poolFeeAprPct: number | null;
};

export type Univ4RangeApr = { tickLower: number; tickUpper: number; halfWidthTicks: number; aprPct: number | null };

export type Univ4AprEstimate = {
  unit: "token0";
  tvl: { amount0: number; amount1: number; valueToken0: number; ranges: number };
  activeLiquidityFromRanges: string;
  windows: Univ4AprWindow[];
  /** Reference ranges centered on the current tick, 7d window. */
  rangeAprs: Univ4RangeApr[];
};

export type EstimateUniv4AprInput = {
  swaps: readonly SwapSample[];
  ranges: readonly RangeLiquidity[];
  sqrtPriceX96: bigint;
  tick: number;
  toBlock: bigint;
  initBlock: bigint;
  blocksPerSecond: number;
  decimals0: number;
  decimals1: number;
};

const SECONDS_PER_YEAR = 365 * 86_400;

export function estimateUniv4Apr(input: EstimateUniv4AprInput): Univ4AprEstimate {
  const sqrtP = Number(input.sqrtPriceX96) / 2 ** 96;
  const price = sqrtP * sqrtP;
  const scale = 10 ** input.decimals0;
  let amount0 = 0, amount1 = 0, active = 0n;
  for (const range of input.ranges) {
    const amounts = amountsForLiquidity(Number(range.liquidity), range.tickLower, range.tickUpper, sqrtP);
    amount0 += amounts.amount0;
    amount1 += amounts.amount1;
    if (range.tickLower <= input.tick && input.tick < range.tickUpper) active += range.liquidity;
  }
  const tvlRaw0 = amount0 + amount1 / price;
  const poolAgeSeconds = Math.max(0, Number(input.toBlock - input.initBlock) / input.blocksPerSecond);
  const windowSwaps = (seconds: number) => {
    const fromBlock = input.toBlock - BigInt(Math.ceil(seconds * input.blocksPerSecond));
    return input.swaps.filter(swap => swap.blockNumber > fromBlock && swap.blockNumber <= input.toBlock);
  };
  const windows = APR_WINDOWS.map(({ label, seconds }): Univ4AprWindow => {
    const swaps = windowSwaps(seconds);
    const coveredSeconds = Math.min(seconds, poolAgeSeconds);
    const feesRaw0 = swaps.reduce((sum, swap) => sum + swapFeeInToken0(swap, price), 0);
    const volumeRaw0 = swaps.reduce((sum, swap) => sum + (swap.amount0 < 0n ? Number(-swap.amount0) : Number(abs(swap.amount1)) / price), 0);
    return {
      label, coveredSeconds, swapCount: swaps.length, volumeToken0: volumeRaw0 / scale, feesToken0: feesRaw0 / scale,
      poolFeeAprPct: tvlRaw0 > 0 && coveredSeconds > 0 ? (feesRaw0 / tvlRaw0) * (SECONDS_PER_YEAR / coveredSeconds) * 100 : null,
    };
  });
  const week = APR_WINDOWS[1];
  const weekSwaps = windowSwaps(week.seconds);
  const weekSeconds = Math.min(week.seconds, poolAgeSeconds);
  const rangeAprs = RANGE_APR_HALF_WIDTHS.map((halfWidth): Univ4RangeApr => {
    const tickLower = input.tick - halfWidth, tickUpper = input.tick + halfWidth;
    const perL = amountsForLiquidity(1, tickLower, tickUpper, sqrtP);
    const valuePerL = perL.amount0 + perL.amount1 / price;
    const feesPerL = weekSwaps
      .filter(swap => swap.liquidity > 0n && tickLower <= swap.tick && swap.tick < tickUpper)
      .reduce((sum, swap) => sum + swapFeeInToken0(swap, price) / Number(swap.liquidity), 0);
    return { tickLower, tickUpper, halfWidthTicks: halfWidth, aprPct: valuePerL > 0 && weekSeconds > 0 ? (feesPerL / valuePerL) * (SECONDS_PER_YEAR / weekSeconds) * 100 : null };
  });
  return {
    unit: "token0",
    tvl: { amount0: amount0 / scale, amount1: amount1 / 10 ** input.decimals1, valueToken0: tvlRaw0 / scale, ranges: input.ranges.length },
    activeLiquidityFromRanges: active.toString(),
    windows,
    rangeAprs,
  };
}
