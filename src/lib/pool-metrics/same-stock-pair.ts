/**
 * Same-stock pairs are a subset of the registry's same-asset rule: same chain, same underlying,
 * different issuers, and that underlying is a stock (not cash/stable, and not a non-stock
 * same-asset pair such as cbBTC/WBTC).
 *
 * Used only by public SEO surfaces (/pools/{slug}, the SSR table, sitemap, JSON-LD). The
 * interactive pool list is unchanged.
 */
import { isSolHsolMintPair } from "@sofinance/engine/hsol-rate";
import { matchWrapPairShape, STABLECOIN_BASES } from "@/lib/rwa-pairing";
import { isSameAssetPair, type RegistryToken } from "./token-registry";
import { solanaStaticToken } from "./solana-registry";
import rhcRegistry from "./rhc-tokens.json";

export type SameStockPoolInput = {
  chain: "solana" | "robinhood" | string;
  mintA: string;
  mintB: string;
  symbolA: string;
  symbolB: string;
};

/** Underlyings that are same-asset but not stocks (cash, SOL LSTs). */
const NON_STOCK_UNDERLYINGS = new Set([...STABLECOIN_BASES, "SOL"]);

/** True when the underlying ticker is a stock, not a stablecoin base or SOL (USDC/USDT share USD; SOL/hSOL shares SOL). */
export function isStockUnderlying(underlying: string): boolean {
  return !NON_STOCK_UNDERLYINGS.has(underlying.trim().toUpperCase());
}

/** Registry same-asset pair whose underlying is a stock. */
export function isSameStockRegistryPair(a: RegistryToken, b: RegistryToken): boolean {
  return isSameAssetPair(a, b) && isStockUnderlying(a.underlying);
}

function rhcToken(address: string): RegistryToken | undefined {
  const needle = address.toLowerCase();
  return (rhcRegistry.tokens as RegistryToken[]).find((token) => token.address.toLowerCase() === needle);
}


/** Robinhood Chain stock-token ticker: NVDA / NVDAon (Ondo). Stable underlyings do not qualify. */
function matchRhcStockWrap(symbolA: string, symbolB: string): boolean {
  const a = symbolA.trim().toUpperCase();
  const b = symbolB.trim().toUpperCase();
  if (!a || !b || a === b) return false;
  const isOnWrap = (plain: string, wrapped: string) =>
    wrapped === `${plain}ON` && plain.length >= 2 && isStockUnderlying(plain);
  return isOnWrap(a, b) || isOnWrap(b, a);
}

/**
 * Whether a listed pool is a stock / stock-token pair (TSLAx/TSLA, NVDA/NVDAon, …).
 * USDC/USDT (curated stable, underlying USD) and same-asset crypto wraps (cbBTC/WBTC) are not.
 */
export function isSameStockPool(pool: SameStockPoolInput): boolean {
  // Resolve from token registries first (no chain-string branch). Curated Solana
  // stables (USDC/USDT, underlying USD) and RHC tokens are classified here.
  const staticA = solanaStaticToken(pool.mintA);
  const staticB = solanaStaticToken(pool.mintB);
  if (staticA && staticB) return isSameStockRegistryPair(staticA, staticB);

  const rhcA = rhcToken(pool.mintA);
  const rhcB = rhcToken(pool.mintB);
  if (rhcA && rhcB) return isSameStockRegistryPair(rhcA, rhcB);

  // Solana stock wraps (NVDAx/NVDA, SPCXx/SPCX, …). Stablecoin bases are already
  // rejected by the wrap rule. Non-stock same-asset pairs (cbBTC/WBTC) are not
  // FOOx/FOO wraps, so they do not match.
  if (matchWrapPairShape(pool.symbolA, pool.symbolB).matched) return true;

  // Fallback when RHC mints are not in the checked-in registry (tests, or a newly
  // listed pool): Ondo stock tokens use the BASEon ticker next to the plain ticker.
  return matchRhcStockWrap(pool.symbolA, pool.symbolB);
}

/** SOL/hSOL LST pair (either mint order). */
export function isLstPool(pool: Pick<SameStockPoolInput, "mintA" | "mintB">): boolean {
  return isSolHsolMintPair(pool.mintA, pool.mintB);
}

/**
 * Pools that may appear on /pools/{slug}, the SSR table, the sitemap and public JSON-LD:
 * same-stock pairs, plus the curated SOL/hSOL LST pools. USDC/USDT and cbBTC/WBTC stay off these pages.
 */
export function isPublicSeoPool(pool: SameStockPoolInput): boolean {
  return isSameStockPool(pool) || isLstPool(pool);
}
