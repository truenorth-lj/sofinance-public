/**
 * Same-stock pairs are a subset of the registry's same-asset rule: same chain, same underlying,
 * different issuers, and that underlying is a stock (not cash/stable, and not a non-stock
 * same-asset pair such as cbBTC/WBTC).
 *
 * Used only by public SEO surfaces (/pools/{slug}, the SSR table, sitemap, JSON-LD). The
 * interactive pool list is unchanged.
 */
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

/** True when the underlying ticker is a stock, not a stablecoin base (USDC/USDT share underlying USD). */
export function isStockUnderlying(underlying: string): boolean {
  return !STABLECOIN_BASES.has(underlying.trim().toUpperCase());
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
  if (pool.chain === "robinhood") {
    const a = rhcToken(pool.mintA);
    const b = rhcToken(pool.mintB);
    if (a && b) return isSameStockRegistryPair(a, b);
    // Fallback when mints are not in the checked-in registry (tests, or a newly listed pool):
    // Ondo stock tokens use the BASEon ticker next to the plain stock ticker.
    return matchRhcStockWrap(pool.symbolA, pool.symbolB);
  }
  if (pool.chain === "solana") {
    const staticA = solanaStaticToken(pool.mintA);
    const staticB = solanaStaticToken(pool.mintB);
    if (staticA && staticB) return isSameStockRegistryPair(staticA, staticB);
    // Stock wraps (NVDAx/NVDA, SPCXx/SPCX, …). Stablecoin bases are already rejected by the wrap rule.
    // Non-stock same-asset pairs (cbBTC/WBTC) are not FOOx/FOO wraps, so they do not match.
    return matchWrapPairShape(pool.symbolA, pool.symbolB).matched;
  }
  return false;
}
