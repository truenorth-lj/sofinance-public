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

/** Where a stored or quoted ScaledUiAmount config came from. */
export type ScaledUiConfigOrigin = "snapshot" | "jupiter";

/**
 * Facts already read elsewhere in the same request (never fetched here). An on-chain mint account read in this request
 * wins. Otherwise the most recently observed config wins (`observedAtMs`: when the snapshot was taken or the Jupiter
 * response was fetched), so a stale snapshot never overrides a newer issuer schedule.
 */
export type MultiplierHint =
  | { kind: "mint-extensions"; scaledUiConfig: ScaledUiMultiplierConfig | null }
  | { kind: "scaled-ui-config"; origin: ScaledUiConfigOrigin; observedAtMs: number; config: ScaledUiMultiplierConfig }
  | { kind: "issuer"; issuer: string };

/** Where the chosen multiplier came from, for a warning. */
export type MultiplierEvidence = { origin: "mint-account" | ScaledUiConfigOrigin; observedAtMs: number | null; multiplier: number | null };

/**
 * Two facts for one asset disagree on the effective multiplier at evaluation time. The chosen one is used; the warning is
 * plain data for the host to log.
 */
export type ValuationWarning = {
  kind: "multiplier-conflict";
  asset: string;
  chosen: MultiplierEvidence;
  ignored: MultiplierEvidence;
};

/** Evaluation context for resolving assets: the clock, and where warnings go. */
export type ResolveContext = { nowMs: number; warn?: (warning: ValuationWarning) => void };

/** Serializable description of one asset. `createAsset` turns it into behaviour; this is what crosses boundaries. */
export type AssetFacts = {
  ref: AssetRef;
  decimals: number;
  multiplier: MultiplierReading;
  /** Which source produced `multiplier`; null when none recognised the asset (`multiplier` is then unknown). */
  multiplierSource: MultiplierSourceId | null;
};
