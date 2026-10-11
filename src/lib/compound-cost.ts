import type { CompoundSummary } from "./compound-types";

export function tokenUsdValue(raw: string, decimals: number, price: number | null | undefined): number | null {
  if (BigInt(raw) === 0n) return 0;
  if ((price === null || price === undefined) || !Number.isFinite(price) || price <= 0) return null;
  const value = Number(raw) / 10 ** decimals * price;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export function formatUsdcValue(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "USDC estimate unavailable";
  if (value === 0) return "0 USDC";
  if (value < 0.000001) return "< 0.000001 USDC";
  return `${value.toFixed(value < 0.01 ? 6 : 4).replace(/0+$/, "").replace(/\.$/, "")} USDC`;
}

/** Account deposits owned by this wallet are recoverable, so are not expenses. */
export function compoundCost(summary: CompoundSummary, solUsdcRate: number | null, usdcUsd: number | null) {
  const solLamports = summary.feeLamports + (summary.beam?.tipLamports ?? 0) + Number(summary.nonRefundableRentLamports ?? 0);
  let tokenFeesUsd = 0;
  let complete = true;
  for (const swap of summary.swaps ?? []) {
    const price = swap.inputMint === summary.state.mintA ? summary.state.pricing?.priceUsdA : summary.state.pricing?.priceUsdB;
    // Legacy records did not capture the pool trading fee. Never treat it as zero.
    if (swap.poolFeeAmount === undefined) { complete = false; continue; }
    const usd = tokenUsdValue((BigInt(swap.feeAmount ?? "0") + BigInt(swap.poolFeeAmount)).toString(), swap.inputDecimals, price);
    if (usd === null) complete = false;
    else tokenFeesUsd += usd;
  }
  const tokenFeesUsdc = tokenFeesUsd === 0 ? 0 : usdcUsd !== null && usdcUsd > 0 ? tokenFeesUsd / usdcUsd : null;
  const totalUsdc = complete && solUsdcRate !== null && tokenFeesUsdc !== null
    ? solLamports / 1e9 * solUsdcRate + tokenFeesUsdc : null;
  const totalSol = complete && tokenFeesUsd === 0 ? solLamports / 1e9
    : totalUsdc !== null && solUsdcRate !== null && solUsdcRate > 0 ? totalUsdc / solUsdcRate : null;
  return { solLamports, totalSol, totalUsdc, hasTokenFees: tokenFeesUsd > 0, complete };
}
