export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const NATIVE_SOL_MINT = "So11111111111111111111111111111111111111112";
// Wall-clock gate for prepared quotes/txs (client and broadcast). On-chain
// validity is still lastValidBlockHeight (~60–90s). 75s leaves room for slow
// WalletConnect approve without outrunning a freshly stamped blockhash.
export const QUOTE_TTL_MS = 75_000;
export const PREPARE_STALE_MS = 20_000;
export const MAX_PRICE_IMPACT_BPS = 500;
export const DEFAULT_RESALE_FLOOR_BPS = 9_900; // Default: at least 99% estimated resale in the input asset.
export const LOWEST_RESALE_FLOOR_BPS = 9_500; // User may accept at most a 5% estimated immediate resale gap.
export const SLIPPAGE_BPS = 50;
// Add-liquidity price tolerance: liquidity is sized below the conservative swap
// outputs so the pool price may drift by this much between quote and execution
// without failing Raydium's PriceSlippageCheck (6017).
export const DEFAULT_ADD_TOLERANCE_BPS = 100;
// Compound harvest+swap shares the same busy CLMM. 1% (zap default) is not
// enough for ~30–75s of SPCX/SPCXx-class activity between prepare and send.
export const DEFAULT_COMPOUND_ADD_TOLERANCE_BPS = 300;
export const MAX_ADD_TOLERANCE_BPS = 500;
export const MIN_SOL_LAMPORTS = 10_000_000;
