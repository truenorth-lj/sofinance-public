import { getScaledUiAmountConfig, type Mint } from "@solana/spl-token";
import { effectiveScaledUiMultiplier } from "./valuation/multiplier";

export { effectiveScaledUiMultiplier };

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}


/** On-chain ScaledUiAmount multiplier when the mint has a finite, positive config. */
export function scaledUiMultiplierFromMint(mint: Mint, nowMs = Date.now()): number | undefined {
  const scaled = getScaledUiAmountConfig(mint);
  if (!scaled) return undefined;
  const value = effectiveScaledUiMultiplier(scaled, nowMs);
  return isPositiveFinite(value) ? value : undefined;
}
