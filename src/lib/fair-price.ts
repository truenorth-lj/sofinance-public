/**
 * Fair price for a same-stock pool from Token-2022 ScaledUiAmount multipliers.
 * fair = multiplierA / multiplierB (token B per token A, decimals-adjusted / raw).
 * Returns null when that fair price and the pool's current raw price differ by more than 2%,
 * so a disconnected multiplier (e.g. SNDK at 8 vs a ~1 pool price) is not shown or applied.
 * Display only — does not change ticks, amounts, or anything that gets signed.
 *
 * Price units: Raydium API `price` is raw (decimals only). Meteora datapi `current_price`
 * (`priceBPerA`) includes the ScaledUiAmount multiplier (share-UI Y per share-UI X).
 * fairPriceFromPool converts a Meteora price back to raw before the 2% gate.
 */

export { effectiveScaledUiMultiplier } from "@sofinance/engine/valuation/multiplier";

import { uiFor } from "./dex/ui";
import { poolPairLabelFromSymbols } from "./pool-names";

const FAIR_PRICE_MAX_RELATIVE_DIFF = 0.02;

/** Half a unit in the 5th decimal — below this, a fair price is treated as 1 for display. */
const DISPLAY_ONE_EPS = 5e-6;

type FairPricePool = {
  symbolA: string;
  symbolB: string;
  /** Effective ScaledUiAmount multiplier (1 when the mint has no config). */
  multiplierA: number;
  multiplierB: number;
  /**
   * Official fair price as token B per token A, when it is not the ScaledUi
   * multiplier ratio (SOL/hSOL: the stake-pool exchange rate).
   */
  fairPriceBPerA?: number;
  /** Current raw UI price, token B per token A (decimals only, no ScaledUi multiplier). */
  price: number;
};

type FairPrice = {
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

function trimTrailingZeros(text: string): string {
  return text.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "");
}

/** Format a multiplier for the "1 TOKENx = 1.0017 shares" line (4 decimals, more if 4 would hide a small step). */
export function formatShareMultiplier(multiplier: number): string {
  if (Math.abs(multiplier - 1) < DISPLAY_ONE_EPS) return "1";
  for (let digits = 4; digits <= 8; digits++) {
    const text = multiplier.toFixed(digits);
    if (!isOne(Number(text))) return trimTrailingZeros(text);
  }
  return trimTrailingZeros(multiplier.toFixed(4));
}

/**
 * "Fair price: 1 NVDAx ≈ 1.0017 NVDA" — tokens in the same order as the on-screen pairLabel
 * (Solana: wrapped / plain). `fair` is token B per token A (raw).
 */
export function formatFairPriceLine(pool: {
  symbolA: string;
  symbolB: string;
  fair: number;
  pairLabel?: string;
}): string {
  const label = pool.pairLabel ?? poolPairLabelFromSymbols(pool.symbolA, pool.symbolB, "/");
  const parts = label.split("/").map((part) => part.trim()).filter(Boolean);
  const first = parts[0] ?? pool.symbolA;
  const second = parts[1] ?? pool.symbolB;
  const amount = first === pool.symbolB && first !== pool.symbolA ? 1 / pool.fair : pool.fair;
  return `Fair price: 1 ${first} ≈ ${formatShareMultiplier(amount)} ${second}`;
}

/**
 * Convert a list/API price to raw token-B-per-token-A (decimals only).
 * Meteora datapi `current_price` already includes the ScaledUiAmount multiplier;
 * Raydium `price` does not.
 */
export function rawPriceBPerA(pool: {
  protocol?: string;
  multiplierA: number;
  multiplierB: number;
  priceBPerA: number;
}): number {
  const includesScaledUi = pool.protocol !== undefined && uiFor(pool.protocol).listPriceIncludesScaledUi === true;
  if (includesScaledUi) return pool.priceBPerA * (pool.multiplierA / pool.multiplierB);
  return pool.priceBPerA;
}

/** Fair raw price, or null when it and the pool price differ by more than 2% (or inputs are unusable). */
export function fairPriceFor(pool: FairPricePool): FairPrice | null {
  const { multiplierA, multiplierB, fairPriceBPerA, price } = pool;
  if (![multiplierA, multiplierB, price].every(isPositiveFinite)) return null;
  const official = isPositiveFinite(fairPriceBPerA) ? fairPriceBPerA : null;
  const fair = official ?? (multiplierA / multiplierB);
  if (!isPositiveFinite(fair)) return null;
  if (Math.abs(price - fair) / fair > FAIR_PRICE_MAX_RELATIVE_DIFF) return null;
  const shareLines: string[] = [];
  if (!isOne(multiplierA)) shareLines.push(`1 ${pool.symbolA} = ${formatShareMultiplier(multiplierA)} shares`);
  if (!isOne(multiplierB)) shareLines.push(`1 ${pool.symbolB} = ${formatShareMultiplier(multiplierB)} shares`);
  return { fair, multiplierA, multiplierB, shareLines };
}

/** Same as fairPriceFor, from a list/page pool row. Missing price or multipliers → null (do not assume 1). */
function fairPriceFromPool(pool: {
  symbolA: string;
  symbolB: string;
  protocol?: string;
  multiplierA?: number;
  multiplierB?: number;
  fairPriceBPerA?: number;
  priceBPerA?: number | null;
}): FairPrice | null {
  if (pool.multiplierA === undefined || pool.multiplierA === null || pool.multiplierB === undefined || pool.multiplierB === null || pool.priceBPerA === undefined || pool.priceBPerA === null) return null;
  return fairPriceFor({
    symbolA: pool.symbolA,
    symbolB: pool.symbolB,
    multiplierA: pool.multiplierA,
    multiplierB: pool.multiplierB,
    ...(isPositiveFinite(pool.fairPriceBPerA) ? { fairPriceBPerA: pool.fairPriceBPerA } : {}),
    price: rawPriceBPerA({
      protocol: pool.protocol,
      multiplierA: pool.multiplierA,
      multiplierB: pool.multiplierB,
      priceBPerA: pool.priceBPerA,
    }),
  });
}

/**
 * User-facing note when the fair price itself differs from 1 (DISPLAY_ONE_EPS).
 * Null when fairPriceFor is null or fair is 1 (e.g. SNDK/SNDKx, both multipliers 8).
 */
export function scaledUiFairNote(pool: {
  symbolA: string;
  symbolB: string;
  protocol?: string;
  pairLabel?: string;
  multiplierA?: number;
  multiplierB?: number;
  fairPriceBPerA?: number;
  priceBPerA?: number | null;
}): string | null {
  const result = fairPriceFromPool(pool);
  if (!result || Math.abs(result.fair - 1) < DISPLAY_ONE_EPS) return null;
  const pairLabel = pool.pairLabel;
  const fairLine = formatFairPriceLine({ symbolA: pool.symbolA, symbolB: pool.symbolB, fair: result.fair, ...(pairLabel ? { pairLabel } : {}) });
  if (result.shareLines.length === 0) return fairLine;
  return `${result.shareLines.join(". ")}. ${fairLine}`;
}
