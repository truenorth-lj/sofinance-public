import type { PriceQuote, PriceSourceId } from "../types";

/** One provider's prices and the unit they are in. Turns a provider value into a `PriceQuote`; never does I/O. */
export type PriceSource<Input> = {
  readonly id: PriceSourceId;
  readonly basis: PriceQuote["basis"];
  toQuote(input: Input): PriceQuote | null;
};

export const isUsablePrice = (usd: number): boolean => Number.isFinite(usd) && usd > 0;
