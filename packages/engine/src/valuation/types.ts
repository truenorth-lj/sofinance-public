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
  | { kind: "unpriced"; reason: "invalid-input" | "multiplier-unknown" };
