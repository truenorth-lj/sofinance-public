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
  /**
   * Units of the shared underlying per token, when that is not the ScaledUi
   * multiplier (e.g. official SOL per hSOL). When set, this is used instead of
   * `multiplier`. null means the unit is unknown (same as a missing multiplier).
   */
  underlyingPerToken?: number | null;
};

export type PoolSharePrice =
  | { kind: "known"; usdPerShare: number }
  | { kind: "unknown"; reason: "multiplier-unknown" | "no-reserves" | "invalid-input" };

const finitePositive = (value: number | null | undefined): value is number => value !== null && value !== undefined && Number.isFinite(value) && value > 0;

/** Share units for one side: an explicit underlying rate when present, otherwise the ScaledUi multiplier. */
function underlyingUnitsOf(side: PoolShareSide): number | null {
  if (side.underlyingPerToken !== undefined) return finitePositive(side.underlyingPerToken) ? side.underlyingPerToken : null;
  return finitePositive(side.multiplier) ? side.multiplier : null;
}

export function sameAssetUsdPerShare(input: {
  tvlUsd: number | null;
  sides: readonly [PoolShareSide, PoolShareSide];
}): PoolSharePrice {
  const { tvlUsd, sides } = input;
  if (!finitePositive(tvlUsd) || !sides.every((side) => Number.isFinite(side.amount) && side.amount >= 0)) {
    return { kind: "unknown", reason: "invalid-input" };
  }
  const units = sides.map(underlyingUnitsOf);
  if (!units.every(finitePositive)) return { kind: "unknown", reason: "multiplier-unknown" };
  const shares = sides.reduce((total, side, index) => total + side.amount * units[index]!, 0);
  if (!(shares > 0)) return { kind: "unknown", reason: "no-reserves" };
  const usdPerShare = tvlUsd / shares;
  return Number.isFinite(usdPerShare) && usdPerShare > 0 ? { kind: "known", usdPerShare } : { kind: "unknown", reason: "invalid-input" };
}
