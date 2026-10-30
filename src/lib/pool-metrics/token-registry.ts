/**
 * General RWA token registry and the one pairing rule every chain uses.
 *
 * A registry token says who issued a token and what it tracks: chain, address, issuer, underlying ticker
 * (ISIN when the issuer publishes one) and how that identity was verified. Two tokens form a same-asset pair
 * when they are on the same chain, track the same underlying and come from different issuers. Finding the
 * pools for a pair stays per protocol (Raydium scan, Orca / Meteora / Uniswap v4 allowlists, v4 pool ids).
 *
 * Sources per chain:
 * - Solana: generated per discovery run (`solana-registry.ts`) from the Raydium scan, Jupiter tags and the
 *   Backed xStocks list, so new mints are still picked up without a code change; plus static entries for
 *   curated pools (USDC / USDT).
 * - Robinhood Chain: the checked-in `rhc-tokens.json`, regenerated offline by `scripts/rhc-token-registry.ts`
 *   (Robinhood asset registry + Ondo factory, each token's issuer beacon checked on chain).
 */
export type RegistryChain = "solana" | "robinhood";

export type TokenVerification =
  /** Jupiter Tokens API tags include `stocks` or `rwa`. */
  | { method: "jupiter-tags"; tags: readonly string[] }
  /** Solana deployment on the Backed xStocks public assets list. */
  | { method: "xstocks-whitelist" }
  /** Curated in code (a pool allowlist). */
  | { method: "allowlist" }
  /** EIP-1967 beacon slot equals the issuer's token beacon (checked on chain). */
  | { method: "issuer-beacon"; beacon: string };

export type RegistryToken = {
  chain: RegistryChain;
  address: string;
  symbol: string;
  /** Issuer key. Tokens of the same issuer never pair with each other. */
  issuer: string;
  /** Underlying ticker (upper case). */
  underlying: string;
  isin?: string | null;
  decimals?: number;
  verification: TokenVerification;
};

export type RegistryPair<T extends RegistryToken = RegistryToken> = { underlying: string; a: T; b: T };

/** The pairing rule: same chain, same underlying, different issuer. */
export function isSameAssetPair(a: RegistryToken, b: RegistryToken): boolean {
  return a.chain === b.chain && a.underlying === b.underlying && a.issuer !== b.issuer
    && a.address.toLowerCase() !== b.address.toLowerCase();
}

/**
 * Pair two tokens given each one's registry entries (a token can have more than one reading, e.g. a Solana
 * ticker that is both a plain ticker and a wrap of a shorter one). Returns the first matching reading pair.
 */
export function pairRegistryTokens<T extends RegistryToken>(a: readonly T[], b: readonly T[]): RegistryPair<T> | null {
  for (const left of a) for (const right of b) if (isSameAssetPair(left, right)) return { underlying: left.underlying, a: left, b: right };
  return null;
}

/** Every same-asset pair in a token list (each unordered pair once, in list order). */
export function sameAssetPairs<T extends RegistryToken>(tokens: readonly T[]): RegistryPair<T>[] {
  const pairs: RegistryPair<T>[] = [];
  for (let i = 0; i < tokens.length; i++)
    for (let j = i + 1; j < tokens.length; j++)
      if (isSameAssetPair(tokens[i]!, tokens[j]!)) pairs.push({ underlying: tokens[i]!.underlying, a: tokens[i]!, b: tokens[j]! });
  return pairs;
}
