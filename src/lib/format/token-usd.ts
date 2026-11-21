/**
 * Display-only "≈ $" for one token amount. `usdPerRawUnit` is USD per (raw / 10^decimals) token unit with the
 * multiplier already applied (`SelectedDisplayPricing`), so amounts are never multiplied again here.
 */
function approxUsd(units: number, usdPerRawUnit: number | null | undefined): string | null {
  if (typeof usdPerRawUnit !== "number" || !Number.isFinite(usdPerRawUnit) || usdPerRawUnit < 0) return null;
  if (!Number.isFinite(units) || units < 0) return null;
  const usd = units * usdPerRawUnit;
  if (!Number.isFinite(usd)) return null;
  return usd < 0.01 ? "< $0.01" : `≈ $${usd.toFixed(2)}`;
}

/** A raw on-chain balance (e.g. the wallet's selected asset). */
export function rawAmountUsdLabel(raw: string, decimals: number, usdPerRawUnit: number | null | undefined): string | null {
  try {
    return approxUsd(Number(BigInt(raw)) / 10 ** decimals, usdPerRawUnit);
  } catch {
    return null;
  }
}

/** A typed amount in raw / 10^decimals units (the Add input field). Empty or non-positive input shows nothing. */
export function typedAmountUsdLabel(amount: string, usdPerRawUnit: number | null | undefined): string | null {
  const units = Number(amount);
  if (!amount || !Number.isFinite(units) || units <= 0) return null;
  return approxUsd(units, usdPerRawUnit);
}
