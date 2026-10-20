import { USDC_MINT } from "@sofinance/engine/ids";

/** USD notional when the open input is USDC; otherwise unknown (no extra price fetch on the broadcast path). */
export function notionalUsdFromQuote(quote: {
  inputMint?: string;
  inputDecimals?: number;
  requested?: string;
} | null | undefined): number | null {
  if (!quote || quote.inputMint !== USDC_MINT) return null;
  const requested = quote.requested;
  if (typeof requested !== "string" || !/^\d+$/.test(requested)) return null;
  const decimals = Number.isInteger(quote.inputDecimals) ? quote.inputDecimals! : 6;
  if (decimals < 0 || decimals > 18) return null;
  const value = Number(requested) / 10 ** decimals;
  return Number.isFinite(value) ? value : null;
}
