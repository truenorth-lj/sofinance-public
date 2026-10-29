/** Meteora DLMM (Liquidity Book) mainnet program and its public data API. */
export const METEORA_DLMM_PROGRAM_ID = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
export const METEORA_DLMM_DATAPI = "https://dlmm.datapi.meteora.ag";

export const CBBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
export const WBTC_WORMHOLE_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";
/** Meteora reports an unset reward mint as the System Program id. */
export const METEORA_NO_REWARD_MINT = "11111111111111111111111111111111";
export const SPL_TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export type MeteoraAllowlistedPool = {
  poolAddress: string;
  /** Meteora token X / token Y (order matters: bins above the active bin hold X, bins below hold Y). */
  mintX: string;
  mintY: string;
  /** Token program of each mint (checked on-chain when the pool is added; datapi does not report it). */
  tokenProgramX: string;
  tokenProgramY: string;
  /** Expected bin step (bps per bin). A pool whose bin step differs is rejected. */
  binStep: number;
  /** Shared underlying (display). */
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
};

/**
 * Curated Meteora DLMM pools. Discovery is allowlist-only: a pool is listed only
 * when its id, X/Y mint pair and bin step all match and Meteora does not blacklist it.
 * cbBTC/WBTC bin step 1 (0.01% base fee) uses the same mints as the Orca pool and
 * contains no SOL (~$336k TVL as of 2026-10-29).
 */
export const METEORA_ALLOWLISTED_POOLS: readonly MeteoraAllowlistedPool[] = Object.freeze([
  Object.freeze({
    poolAddress: "53oyyjgybx6dH7i5aGeKfBUi3xPJQDeBkaENPri57x2H",
    mintX: CBBTC_MINT,
    mintY: WBTC_WORMHOLE_MINT,
    tokenProgramX: SPL_TOKEN_PROGRAM_ID,
    tokenProgramY: SPL_TOKEN_PROGRAM_ID,
    binStep: 1,
    baseSymbol: "BTC",
    wrappedSymbol: "cbBTC",
    plainSymbol: "WBTC",
  }),
]);
