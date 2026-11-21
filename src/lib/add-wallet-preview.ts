/**
 * The Add wallet preview's dollar split, from the quote already on screen (no new reads). The wallet's own preview
 * lists only the tokens coming back to it: the price-tolerance reserve (`dust`, the swap output the deposit does not
 * use). The rest of the swap output (`required`) goes into the position, which wallets do not show as incoming.
 */
export type AddWalletPreviewQuote = {
  requiredA: string; requiredB: string; dustA: string; dustB: string; decimalsA: number; decimalsB: number;
};
/** USD per (raw / 10^decimals) token unit, multiplier already applied (`SelectedDisplayPricing`); display only. */
export type AddWalletPreviewPrices = { usdPerRawUnitA?: number | null; usdPerRawUnitB?: number | null };

const usdOf = (raw: string, decimals: number, usdPerRawUnit: number) => Number(BigInt(raw)) / 10 ** decimals * usdPerRawUnit;
// A zero price is as unknown as a missing one (an unpriced token would read as "$0.00 coming back").
const usable = (price: number | null | undefined): price is number => typeof price === "number" && Number.isFinite(price) && price > 0;

/** `null` when either token has no (or a zero) USD price: the line is left out rather than guessed. */
export function addWalletPreviewSplit(quote: AddWalletPreviewQuote, prices: AddWalletPreviewPrices | null | undefined): { backUsd: number; depositUsd: number } | null {
  const priceA = prices?.usdPerRawUnitA; const priceB = prices?.usdPerRawUnitB;
  if (!usable(priceA) || !usable(priceB)) return null;
  const backUsd = usdOf(quote.dustA, quote.decimalsA, priceA) + usdOf(quote.dustB, quote.decimalsB, priceB);
  const depositUsd = usdOf(quote.requiredA, quote.decimalsA, priceA) + usdOf(quote.requiredB, quote.decimalsB, priceB);
  if (!Number.isFinite(backUsd) || !Number.isFinite(depositUsd)) return null;
  return { backUsd, depositUsd };
}
