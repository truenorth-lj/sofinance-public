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
 *
 * SOL/hSOL: Raydium CLMM 1 bps pool 51V5bAPGaz3vj4SiJeoLGNzAQNxGr4Vps8gSBKmSZx71
 * (LJ, 2026-11-25). hSOL is Helius Staked SOL. Display uses SOL, not WSOL.
 *
 * cbBTC/WBTC: Raydium CLMM 1 bps pool 8GuXrPq6deS1ZzNXYmBjVZ5P48cAmKGrhhpdAn2FURPC (LJ, 2026-11-26). cbBTC is Coinbase
 * Wrapped BTC; WBTC is the Wormhole (Portal) wrapped mint, not BitGo's native WBTC mint. Both are plain SPL mints
 * and the pair has no official rate: the range is centered on the on-chain price.
 */

import { NATIVE_SOL_MINT } from "@sofinance/engine/ids";
import { HSOL_MINT } from "@sofinance/engine/hsol-rate";
import { CBBTC_MINT, WBTC_WORMHOLE_MINT } from "@sofinance/engine/protocols/meteora/constants";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
export { NATIVE_SOL_MINT, HSOL_MINT };
/** Coinbase Wrapped BTC and the Wormhole (Portal) WBTC on Solana. */
export { CBBTC_MINT };
export const WBTC_PORTAL_MINT = WBTC_WORMHOLE_MINT;

/** Deepest Raydium CLMM USDC/USDT pool on Solana mainnet (1 bps). */
export const USDC_USDT_CLMM_POOL_ID = "BZtgQEyS6eXUXicYPHecYQ7PybqodXQMvkjUbP4R8mUU";

/** Raydium CLMM SOL/hSOL pool on Solana mainnet (1 bps). */
export const SOL_HSOL_CLMM_POOL_ID = "51V5bAPGaz3vj4SiJeoLGNzAQNxGr4Vps8gSBKmSZx71";

/** Raydium CLMM cbBTC/WBTC pool on Solana mainnet (1 bps). */
export const CBBTC_WBTC_CLMM_POOL_ID = "8GuXrPq6deS1ZzNXYmBjVZ5P48cAmKGrhhpdAn2FURPC";

/** How a curated (non-FOOx/FOO) pair is labelled on the row. */
export type AllowlistWrapKind = "stable" | "same-asset" | "lst";

export type AllowlistedPoolSpec = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  /** Shared underlying label for display (USD for the stable pair, SOL for SOL/hSOL, BTC for cbBTC/WBTC). */
  baseSymbol: string;
  /** Shown first in pair labels / icons (USDC so deposit-USDC reads naturally; SOL for SOL/hSOL). */
  wrappedSymbol: string;
  plainSymbol: string;
  wrapKind: AllowlistWrapKind;
};

export const ALLOWLISTED_CLMM_POOLS: readonly AllowlistedPoolSpec[] = [
  {
    poolAddress: USDC_USDT_CLMM_POOL_ID,
    mintA: USDC_MINT,
    mintB: USDT_MINT,
    baseSymbol: "USD",
    wrappedSymbol: "USDC",
    plainSymbol: "USDT",
    wrapKind: "stable",
  },
  {
    poolAddress: SOL_HSOL_CLMM_POOL_ID,
    mintA: NATIVE_SOL_MINT,
    mintB: HSOL_MINT,
    baseSymbol: "SOL",
    wrappedSymbol: "SOL",
    plainSymbol: "hSOL",
    wrapKind: "lst",
  },
  {
    poolAddress: CBBTC_WBTC_CLMM_POOL_ID,
    mintA: CBBTC_MINT,
    mintB: WBTC_PORTAL_MINT,
    baseSymbol: "BTC",
    wrappedSymbol: "cbBTC",
    plainSymbol: "WBTC",
    wrapKind: "same-asset",
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
