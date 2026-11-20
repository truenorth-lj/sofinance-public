/**
 * Fair raw price for a same-stock pool from Token-2022 ScaledUiAmount multipliers.
 * fair = multiplierA / multiplierB (token B per token A, raw / decimals-adjusted).
 * Returns null when that fair price and the pool's current raw price differ by more than 2%,
 * so a disconnected multiplier (e.g. SNDK at 8 vs a ~1 pool price) is not shown or applied.
 * Display only — does not change ticks, amounts, or anything that gets signed.
 */

export const FAIR_PRICE_MAX_RELATIVE_DIFF = 0.02;

export type FairPricePool = {
  symbolA: string;
  symbolB: string;
  /** Effective ScaledUiAmount multiplier (1 when the mint has no config). */
  multiplierA: number;
  multiplierB: number;
  /** Current raw UI price, token B per token A. */
  price: number;
};

export type FairPrice = {
  fair: number;
  multiplierA: number;
  multiplierB: number;
  /** e.g. "1 NVDAx = 1.0017 shares" for each side whose multiplier is not 1. */
  shareLines: string[];
};

const NEAR_ONE = 1e-12;

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function isOne(value: number): boolean {
  return Math.abs(value - 1) <= NEAR_ONE;
}

/** Format a multiplier for the "1 TOKENx = 1.0017 shares" line (4 decimals, more if 4 would hide a small step). */
const DISPLAY_ONE_EPS = 5e-6; // half a unit in the 5th decimal — below this, "1" is honest (ignore float noise)

function trimTrailingZeros(text: string): string {
  return text.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

export function formatShareMultiplier(multiplier: number): string {
  if (Math.abs(multiplier - 1) < DISPLAY_ONE_EPS) return "1";
  for (let digits = 4; digits <= 8; digits++) {
    const text = multiplier.toFixed(digits);
    if (!isOne(Number(text))) return trimTrailingZeros(text);
  }
  return trimTrailingZeros(multiplier.toFixed(4));
}

export function formatFairPrice(fair: number): string {
  return formatShareMultiplier(fair);
}

/**
 * Effective ScaledUiAmount multiplier: `newMultiplier` once its timestamp has passed, otherwise `multiplier`.
 * Timestamps may be seconds or milliseconds.
 */
export function effectiveScaledUiMultiplier(
  config: { multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp?: bigint | number | string | null },
  nowMs = Date.now(),
): number {
  const current = Number(config.multiplier);
  const next = Number(config.newMultiplier);
  const raw = config.newMultiplierEffectiveTimestamp;
  const ts = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (isPositiveFinite(next) && Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    if (nowMs >= ms) return next;
  }
  return current;
}

/** Fair raw price, or null when it and the pool price differ by more than 2% (or inputs are unusable). */
export function fairPriceFor(pool: FairPricePool): FairPrice | null {
  const { multiplierA, multiplierB, price } = pool;
  if (![multiplierA, multiplierB, price].every(isPositiveFinite)) return null;
  const fair = multiplierA / multiplierB;
  if (!isPositiveFinite(fair)) return null;
  if (Math.abs(price - fair) / fair > FAIR_PRICE_MAX_RELATIVE_DIFF) return null;
  const shareLines: string[] = [];
  if (!isOne(multiplierA)) shareLines.push(`1 ${pool.symbolA} = ${formatShareMultiplier(multiplierA)} shares`);
  if (!isOne(multiplierB)) shareLines.push(`1 ${pool.symbolB} = ${formatShareMultiplier(multiplierB)} shares`);
  return { fair, multiplierA, multiplierB, shareLines };
}

/** Same as fairPriceFor, from a list/page pool row. Missing price or multipliers → null (do not assume 1). */
export function fairPriceFromPool(pool: {
  symbolA: string;
  symbolB: string;
  multiplierA?: number;
  multiplierB?: number;
  priceBPerA?: number | null;
}): FairPrice | null {
  if (pool.multiplierA === undefined || pool.multiplierA === null || pool.multiplierB === undefined || pool.multiplierB === null || pool.priceBPerA === undefined || pool.priceBPerA === null) return null;
  return fairPriceFor({
    symbolA: pool.symbolA,
    symbolB: pool.symbolB,
    multiplierA: pool.multiplierA,
    multiplierB: pool.multiplierB,
    price: pool.priceBPerA,
  });
}

/** User-facing note when a non-1 multiplier should be shown; null when fairPriceFor is null or both multipliers are 1. */
export function scaledUiFairNote(pool: {
  symbolA: string;
  symbolB: string;
  multiplierA?: number;
  multiplierB?: number;
  priceBPerA?: number | null;
}): string | null {
  const result = fairPriceFromPool(pool);
  if (!result || result.shareLines.length === 0) return null;
  return `${result.shareLines.join(". ")}. Fair price ${formatFairPrice(result.fair)}.`;
}
