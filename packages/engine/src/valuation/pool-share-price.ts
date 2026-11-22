/**
 * USD per real share of a same-asset pool (same-stock pairs like NVDAx/NVDA, or a stablecoin pair), from the pool's TVL
 * and its reserves. Pure, no I/O. SP-2: the pools calculator counts in the pool's own asset and shows ≈$ beside it.
 *
 * Each side's reserve is raw / 10^decimals; × its effective ScaledUiAmount multiplier it becomes real shares, so
 * `usdPerShare = tvlUsd / (amountA × multiplierA + amountB × multiplierB)`. The TVL must already be in the registry's
 * unit (multiplier included: Raydium's API figure, or a Meteora figure after `scaledUiTvlUsd`). Both sides are the same
 * asset, so one price covers both. An unknown multiplier is never treated as 1: the result is `unknown`.
 */
export type PoolShareSide = {
  /** Reserve as raw / 10^decimals (no multiplier). */
  amount: number;
  /** Effective multiplier at evaluation time; null when unknown. */
  multiplier: number | null;
};

export type PoolSharePrice =
  | { kind: "known"; usdPerShare: number }
  | { kind: "unknown"; reason: "multiplier-unknown" | "no-reserves" | "invalid-input" };

const finitePositive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

export function sameAssetUsdPerShare(input: {
  tvlUsd: number | null;
  sides: readonly [PoolShareSide, PoolShareSide];
}): PoolSharePrice {
  const { tvlUsd, sides } = input;
  if (!finitePositive(tvlUsd) || !sides.every((side) => Number.isFinite(side.amount) && side.amount >= 0)) {
    return { kind: "unknown", reason: "invalid-input" };
  }
  if (!sides.every((side) => finitePositive(side.multiplier))) return { kind: "unknown", reason: "multiplier-unknown" };
  const shares = sides.reduce((total, side) => total + side.amount * side.multiplier!, 0);
  if (!(shares > 0)) return { kind: "unknown", reason: "no-reserves" };
  const usdPerShare = tvlUsd / shares;
  return Number.isFinite(usdPerShare) && usdPerShare > 0 ? { kind: "known", usdPerShare } : { kind: "unknown", reason: "invalid-input" };
}
