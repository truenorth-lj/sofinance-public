import { isCuratedCryptoPool } from "@/lib/pool-metrics/same-stock-pair";

/** Same-stock pools: the open-range checkbox still recenters on the ScaledUi fair price. */
export const CENTER_ON_FAIR_LABEL = "Center range on the fair price";

/** BTC same-asset and LST pools: same control, wording that does not say "fair price". */
export const CENTER_ON_CURRENT_PRICE_LABEL = "Center range on the current pool price";

/** Calculator footnote clause for a same-stock pair. */
export const STOCK_PRICE_MOVE_NOTE = "The stock's own price moves both sides alike and is left out.";

/** Calculator footnote clause for a BTC same-asset or LST pair. */
export const SAME_ASSET_PRICE_MOVE_NOTE = "Both tokens track the same asset, and that move is left out.";

type MintPair = { mintA?: string | null; mintB?: string | null };

/**
 * Wording for BTC wraps and SOL/hSOL is neutral; everything else (same-stock, stables, unknown mints)
 * keeps the existing stock phrasing. Derived from the curated-crypto mint predicates, not a new flag.
 */
export function isNeutralAssetCopyPool(pool: MintPair): boolean {
  return Boolean(pool.mintA && pool.mintB && isCuratedCryptoPool({ mintA: pool.mintA, mintB: pool.mintB }));
}

export function centerRangeLabel(pool: MintPair): string {
  return isNeutralAssetCopyPool(pool) ? CENTER_ON_CURRENT_PRICE_LABEL : CENTER_ON_FAIR_LABEL;
}

export function shareCalcPriceMoveNote(pool: MintPair): string {
  return isNeutralAssetCopyPool(pool) ? SAME_ASSET_PRICE_MOVE_NOTE : STOCK_PRICE_MOVE_NOTE;
}
