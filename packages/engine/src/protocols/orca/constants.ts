/** Orca Whirlpools mainnet program and the main WhirlpoolsConfig. */
export const ORCA_WHIRLPOOL_PROGRAM_ID = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
export const ORCA_WHIRLPOOLS_CONFIG = "2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ";
export const ORCA_API_V2 = "https://api.orca.so/v2/solana";

export const CBBTC_MINT = "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij";
export const WBTC_WORMHOLE_MINT = "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh";

export type OrcaAllowlistedPool = {
  poolAddress: string;
  mintA: string;
  mintB: string;
  /** Shared underlying (display). */
  baseSymbol: string;
  wrappedSymbol: string;
  plainSymbol: string;
};

/**
 * Curated Orca Whirlpools. Discovery is allowlist-only: a pool is listed only
 * when its id, mint pair and WhirlpoolsConfig all match and Orca does not flag
 * it. cbBTC/WBTC 1 bp (tick spacing 1) is the deepest same-asset Orca pool
 * (~$1.26M TVL, ~$10.4M 7d volume as of 2026-10-29).
 */
export const ORCA_ALLOWLISTED_POOLS: readonly OrcaAllowlistedPool[] = Object.freeze([
  Object.freeze({
    poolAddress: "4v8ufj8Hj7UvFgtofQJAtzUud5xomwZfEqfCTHZ4wM72",
    mintA: CBBTC_MINT,
    mintB: WBTC_WORMHOLE_MINT,
    baseSymbol: "BTC",
    wrappedSymbol: "cbBTC",
    plainSymbol: "WBTC",
  }),
]);
