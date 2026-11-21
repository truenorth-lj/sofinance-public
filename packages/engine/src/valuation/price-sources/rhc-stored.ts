import { isUsablePrice, type PriceSource } from "./types";

/** Robinhood Chain prices the cron already stored (`tokenPricesUsd`, GeckoTerminal/DexScreener): per raw unit. */
export const rhcStoredPriceSource: PriceSource<number> = {
  id: "rhc-stored",
  basis: "per-raw-unit",
  toQuote: (usd) => (isUsablePrice(usd) ? { basis: "per-raw-unit", usd, source: "rhc-stored" } : null),
};
