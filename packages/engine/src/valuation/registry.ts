import type { TokenPriceQuote, TokenPriceSource } from "../token-prices";
import { assetKey, createAsset, type Asset } from "./asset";
import type { MultiplierSource } from "./multiplier-sources/types";
import { ondoNoneSource } from "./multiplier-sources/ondo-none";
import { rhcPerRawSource } from "./multiplier-sources/rhc-per-raw";
import { splPlainSource } from "./multiplier-sources/spl-plain";
import { token2022ScaledUiSource } from "./multiplier-sources/token2022-scaled-ui";
import { dexscreenerPriceSource, jupiterPriceSource, raydiumPoolPriceSource } from "./price-sources/token-price-quotes";
import { rhcStoredPriceSource } from "./price-sources/rhc-stored";
import type { PriceSource } from "./price-sources/types";
import type { AssetRef, MultiplierHint, PriceQuote, ResolveContext } from "./types";

type QuoteBySource = { [S in TokenPriceSource]: Extract<TokenPriceQuote, { source: S }> };
export type TokenPriceSources = { [S in TokenPriceSource]: PriceSource<QuoteBySource[S]> };

/** Each provider's adapter is chosen by the quote's own source (a correlated lookup, not a branch on the source). */
function quoteFrom<S extends TokenPriceSource>(sources: TokenPriceSources, quote: QuoteBySource[S]): PriceQuote | null {
  const source: PriceSource<QuoteBySource[S]> = sources[quote.source];
  return source.toQuote(quote);
}

export type AssetInput = { ref: AssetRef; decimals: number; hints?: readonly MultiplierHint[] };

export interface AssetRegistry {
  /**
   * Assets keyed by `assetKey`. Duplicate refs are merged (their hints combined); the first decimals win. No I/O.
   * `context.nowMs` is only used to compare conflicting facts; each asset still evaluates its multiplier at read time.
   */
  resolve(inputs: readonly AssetInput[], context: ResolveContext): Map<string, Asset>;
  /** A `fetchTokenPricesUsd` quote as a `PriceQuote`, unit taken from the source that produced it. */
  quoteOf(quote: TokenPriceQuote): PriceQuote | null;
  /** A stored Robinhood Chain price as a `PriceQuote`. */
  rhcStoredQuote(usd: number): PriceQuote | null;
}

/**
 * Assembles multiplier and price adapters. Multiplier sources are asked in order and the first answer wins; an asset
 * no source recognises is `unknown` (never valued as 1).
 */
export function createAssetRegistry(input: {
  multiplierSources: readonly MultiplierSource[];
  priceSources: TokenPriceSources;
  rhcStored: PriceSource<number>;
}): AssetRegistry {
  const { multiplierSources, priceSources, rhcStored } = input;
  return {
    resolve(inputs, context) {
      const merged = new Map<string, { ref: AssetRef; decimals: number; hints: MultiplierHint[] }>();
      for (const { ref, decimals, hints = [] } of inputs) {
        const key = assetKey(ref);
        const entry = merged.get(key);
        if (entry) entry.hints.push(...hints);
        else merged.set(key, { ref, decimals, hints: [...hints] });
      }
      const assets = new Map<string, Asset>();
      for (const [key, { ref, decimals, hints }] of merged) {
        let found: { source: MultiplierSource; reading: NonNullable<ReturnType<MultiplierSource["read"]>> } | null = null;
        for (const source of multiplierSources) {
          const reading = source.read(ref, hints, context);
          if (reading) { found = { source, reading }; break; }
        }
        assets.set(key, createAsset({
          ref, decimals,
          multiplier: found?.reading ?? { kind: "unknown" },
          multiplierSource: found?.source.id ?? null,
        }));
      }
      return assets;
    },
    quoteOf: (quote) => quoteFrom(priceSources, quote),
    rhcStoredQuote: (usd) => rhcStored.toQuote(usd),
  };
}

/** The production assembly. Order matters: a mint read in this request beats any stored or Jupiter config. */
export const assetRegistry = createAssetRegistry({
  multiplierSources: [token2022ScaledUiSource, splPlainSource, ondoNoneSource, rhcPerRawSource],
  priceSources: { jupiter: jupiterPriceSource, dexscreener: dexscreenerPriceSource, raydium: raydiumPoolPriceSource },
  rhcStored: rhcStoredPriceSource,
});
