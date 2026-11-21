import { multiplierAt } from "./multiplier";
import type { AssetFacts, AssetRef, ValuationQuote, ValuationResult } from "./types";
import { valueOf } from "./value";

/** Behaviour over `AssetFacts`. Built by `createAsset`; send `facts`, never the object, across a boundary. */
export interface Asset {
  readonly facts: AssetFacts;
  /** Effective multiplier at `nowMs`; null when unknown (never treated as 1). */
  multiplierAt(nowMs: number): number | null;
  /** USD per raw unit (raw / 10^decimals) for this quote, or null when it cannot be valued. */
  usdPerRawUnit(quote: ValuationQuote, nowMs: number): number | null;
  value(raw: bigint, quote: ValuationQuote | undefined, nowMs: number): ValuationResult;
}

export const assetKey = (ref: AssetRef): string => `${ref.chain}:${ref.address}`;

export function createAsset(facts: AssetFacts): Asset {
  const value = (raw: bigint, quote: ValuationQuote | undefined, nowMs: number): ValuationResult =>
    quote ? valueOf({ raw, decimals: facts.decimals, multiplier: facts.multiplier, quote, nowMs }) : { kind: "unpriced", reason: "no-quote" };
  return {
    facts,
    multiplierAt: (nowMs) => multiplierAt(facts.multiplier, nowMs),
    usdPerRawUnit: (quote, nowMs) => {
      const result = value(10n ** BigInt(facts.decimals), quote, nowMs);
      return result.kind === "valued" ? result.usdPerRawUnit : null;
    },
    value,
  };
}
