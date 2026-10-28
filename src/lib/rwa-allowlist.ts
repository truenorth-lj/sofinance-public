/**
 * Curated Raydium CLMM pools that are not FOOx/FOO wrap pairs.
 *
 * Stock pairs are still discovered by symbol wrap + Jupiter / xStocks
 * qualification. This list is the sibling gate for pools we want in the
 * same /api/rwa-pairs feed (open / add / compound / withdraw) without
 * relaxing the stablecoin wrap exclusion.
 *
 * USDC/USDT: deepest Solana mainnet Raydium CLMM as of 2026-10-28 via
 * GET /pools/info/list?poolType=concentrated&poolSortField=liquidity
 * (pool BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU, 1 bps, ~$1.93M TVL,
 * ~$2.48M 24h volume). Raydium's own defaultRange for this pool is 0.1%
 * with points 0.1 / 0.3 / 0.5 / 0.8 / 1%; the app's Tight / Standard / Wide
 * (±0.05% / ±0.3% / ±1%) cover that band without changing fee rules.
 */

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export const RAYDIUM_CLMM_PROGRAM_ID = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";

/** Deepest Raydium CLMM USDC/USDT pool on Solana mainnet (1 bps). */
export const USDC_USDT_CLMM_POOL_ID = "BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU";

export type AllowlistedPoolSpec = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  /** Shared underlying label for display (USD for the stable pair). */
  baseSymbol: string;
  /** Shown first in pair labels / icons (USDC so deposit-USDC reads naturally). */
  wrappedSymbol: string;
  plainSymbol: string;
};

export const ALLOWLISTED_CLMM_POOLS: readonly AllowlistedPoolSpec[] = [
  {
    poolAddress: USDC_USDT_CLMM_POOL_ID,
    mintA: USDC_MINT,
    mintB: USDT_MINT,
    baseSymbol: "USD",
    wrappedSymbol: "USDC",
    plainSymbol: "USDT",
  },
];

const ALLOWLIST_BY_ID = new Map(ALLOWLISTED_CLMM_POOLS.map((spec) => [spec.poolAddress, spec]));

export function allowlistedPoolById(poolAddress: string): AllowlistedPoolSpec | undefined {
  return ALLOWLIST_BY_ID.get(poolAddress);
}

export function isAllowlistedPoolId(poolAddress: string): boolean {
  return ALLOWLIST_BY_ID.has(poolAddress);
}

/** Order-independent mint pair check against an allowlist spec. */
export function mintsMatchAllowlist(spec: AllowlistedPoolSpec, mintA: string, mintB: string): boolean {
  if (!mintA || !mintB || mintA === mintB) return false;
  return (mintA === spec.mintA && mintB === spec.mintB) || (mintA === spec.mintB && mintB === spec.mintA);
}

export function missingAllowlistedPoolIds(found: Iterable<string>): string[] {
  const have = new Set(found);
  return ALLOWLISTED_CLMM_POOLS.map((spec) => spec.poolAddress).filter((id) => !have.has(id));
}
