import type { AccountInfo } from "@solana/web3.js";
import type { TokenPriceQuote } from "../token-prices";
import { assetKey } from "./asset";
import { mintAccountHint } from "./multiplier-sources/token2022-scaled-ui";
import { multiplierHintsFromQuote } from "./price-sources/token-price-quotes";
import { assetRegistry } from "./registry";
import type { ValuationWarning } from "./types";

/** Display price of one token with no pair to cross-check (wallet balance, input amount): never guard-corrected. */
export type SingleAssetPrice = {
  /** USD per (raw / 10^decimals) token unit, multiplier already applied; null when it cannot be valued. */
  usdPerRawUnit: number | null;
  /** Effective multiplier at `nowMs`; null when unknown (never treated as 1). */
  multiplier: number | null;
};

/**
 * Prices single Solana tokens from mint accounts the caller already read and quotes it already fetched. No I/O.
 * An on-chain mint read wins over Jupiter's `scaledUiConfig`; a disagreement is reported through `warn`.
 */
export function priceSingleAssets(input: {
  assets: readonly { mint: string; decimals: number; account: AccountInfo<Buffer> | null | undefined; quote: TokenPriceQuote | undefined }[];
  nowMs: number;
  quotesObservedAtMs: number;
  warn?: (warning: ValuationWarning) => void;
}): Map<string, SingleAssetPrice> {
  const resolved = assetRegistry.resolve(input.assets.map(({ mint, decimals, account, quote }) => {
    const hint = mintAccountHint(mint, account);
    return { ref: { chain: "solana" as const, address: mint }, decimals,
      hints: [...(hint ? [hint] : []), ...(quote ? multiplierHintsFromQuote(quote, input.quotesObservedAtMs) : [])] };
  }), { nowMs: input.nowMs, warn: input.warn });
  const out = new Map<string, SingleAssetPrice>();
  for (const { mint, quote } of input.assets) {
    const asset = resolved.get(assetKey({ chain: "solana", address: mint }))!;
    const priced = quote ? assetRegistry.quoteOf(quote) : null;
    out.set(mint, { usdPerRawUnit: priced ? asset.usdPerRawUnit(priced, input.nowMs) : null, multiplier: asset.multiplierAt(input.nowMs) });
  }
  return out;
}
