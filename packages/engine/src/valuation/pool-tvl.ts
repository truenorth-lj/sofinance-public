/**
 * A pool TVL published by a source that values raw token amounts at per-share prices (Meteora datapi, design §0 and P2),
 * brought to the registry's unit: raw / 10^decimals × multiplier × USD per share. Pure, no I/O.
 *
 * The source's own figure is kept as the base and only the missing multiplier part is added per side,
 * `amount × (multiplier − 1) × share price`, so the source's other conventions (its own prices, its own timing) carry over.
 * An unknown multiplier is never treated as 1: the result is `unverified` and the published figure is kept as it is.
 */
export type PublishedTvlSide = {
  /** The side's raw amount / 10^decimals, as the source published it. */
  amount: number;
  /** The source's USD per share for this side; only needed when the multiplier is not 1. */
  sharePriceUsd: number | null;
  /** Effective multiplier at evaluation time; null when unknown. */
  multiplier: number | null;
};

export type ScaledUiTvl =
  | { kind: "corrected"; tvlUsd: number; sourceTvlUsd: number }
  | { kind: "unverified"; tvlUsd: number; sourceTvlUsd: number; reason: "multiplier-unknown" | "unpriced" | "invalid-input" };

const finiteNonNegative = (value: number) => Number.isFinite(value) && value >= 0;
const positive = (value: number | null): value is number => value !== null && Number.isFinite(value) && value > 0;

export function scaledUiTvlUsd(input: { sourceTvlUsd: number; sides: readonly [PublishedTvlSide, PublishedTvlSide] }): ScaledUiTvl {
  const { sourceTvlUsd, sides } = input;
  const unverified = (reason: Extract<ScaledUiTvl, { kind: "unverified" }>["reason"]): ScaledUiTvl =>
    ({ kind: "unverified", tvlUsd: sourceTvlUsd, sourceTvlUsd, reason });
  if (!finiteNonNegative(sourceTvlUsd) || !sides.every((side) => finiteNonNegative(side.amount))) return unverified("invalid-input");
  if (!sides.every((side) => positive(side.multiplier))) return unverified("multiplier-unknown");
  let missing = 0;
  for (const side of sides) {
    if (side.multiplier === 1 || side.amount === 0) continue;
    if (!positive(side.sharePriceUsd)) return unverified("unpriced");
    missing += side.amount * (side.multiplier! - 1) * side.sharePriceUsd;
  }
  const tvlUsd = sourceTvlUsd + missing;
  return Number.isFinite(tvlUsd) && tvlUsd >= 0 ? { kind: "corrected", tvlUsd, sourceTvlUsd } : unverified("invalid-input");
}
