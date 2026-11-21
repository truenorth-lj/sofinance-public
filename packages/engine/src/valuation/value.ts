import Decimal from "decimal.js";
import { multiplierAt } from "./multiplier";
import type { MultiplierReading, ValuationQuote, ValuationResult } from "./types";

/** Pure valuation only. Never changes raw amounts used for transfers or signing. */
export function valueOf(input: {
  raw: bigint;
  decimals: number;
  multiplier: MultiplierReading;
  quote: ValuationQuote;
  nowMs: number;
}): ValuationResult {
  const { raw, decimals, quote } = input;
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 255 ||
      !Number.isFinite(quote.usd) || quote.usd <= 0) {
    return { kind: "unpriced", reason: "invalid-input" };
  }
  // A per-raw quote already includes the multiplier. Do not apply it twice.
  const multiplier = quote.basis === "per-raw-unit" ? 1 : multiplierAt(input.multiplier, input.nowMs);
  if (multiplier === null) return { kind: "unpriced", reason: "multiplier-unknown" };
  const price = new Decimal(quote.usd).mul(multiplier);
  const usdPerRawUnit = price.toNumber();
  const usd = new Decimal(raw.toString()).div(new Decimal(10).pow(decimals)).mul(price).toNumber();
  if (!Number.isFinite(usd) || !Number.isFinite(usdPerRawUnit) || usdPerRawUnit <= 0) {
    return { kind: "unpriced", reason: "invalid-input" };
  }
  return { kind: "valued", usd, usdPerRawUnit };
}
