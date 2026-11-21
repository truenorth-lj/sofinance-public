/** Serializable multiplier config. Retain both values and select at evaluation time. */
export type ScaledUiMultiplierConfig = {
  multiplier: number;
  newMultiplier: number;
  newMultiplierEffectiveTimestamp?: number | string | null;
};

export type MultiplierReading =
  | { kind: "scaled-ui"; config: ScaledUiMultiplierConfig }
  | { kind: "none" }
  | { kind: "unknown" };

/** Unit of a quote, not its provider: fallbacks can have a different basis. */
export type ValuationQuote =
  | { basis: "per-share"; usd: number }
  | { basis: "per-raw-unit"; usd: number };

export type ValuationResult =
  | { kind: "valued"; usd: number; usdPerRawUnit: number }
  | { kind: "unpriced"; reason: "invalid-input" | "multiplier-unknown" | "no-quote" };

export type AssetChain = "solana" | "robinhood";
export type AssetRef = { chain: AssetChain; address: string };

/** Where a quote came from and its unit. Plain data: safe to log or send to the client. */
export type PriceSourceId = "jupiter" | "dexscreener" | "raydium" | "rhc-stored";
export type PriceQuote = ValuationQuote & { source: PriceSourceId; liquidityUsd?: number };

export type MultiplierSourceId = "token2022-scaled-ui" | "spl-plain" | "ondo-none" | "rhc-per-raw";

/**
 * Facts already read elsewhere in the same request (never fetched here). Priority: an on-chain mint account, then the
 * stored snapshot config, then Jupiter's `scaledUiConfig`.
 */
export type MultiplierHint =
  | { kind: "mint-extensions"; scaledUiConfig: ScaledUiMultiplierConfig | null }
  | { kind: "scaled-ui-config"; origin: "snapshot" | "jupiter"; config: ScaledUiMultiplierConfig }
  | { kind: "issuer"; issuer: string };

/** Serializable description of one asset. `createAsset` turns it into behaviour; this is what crosses boundaries. */
export type AssetFacts = {
  ref: AssetRef;
  decimals: number;
  multiplier: MultiplierReading;
  /** Which source produced `multiplier`; null when none recognised the asset (`multiplier` is then unknown). */
  multiplierSource: MultiplierSourceId | null;
};
