import { getScaledUiAmountConfig, type Mint } from "@solana/spl-token";

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

/** Effective ScaledUiAmount multiplier: `newMultiplier` once its timestamp has passed, otherwise `multiplier`. */
export function effectiveScaledUiMultiplier(
  config: { multiplier: number; newMultiplier: number; newMultiplierEffectiveTimestamp?: bigint | number | string | null },
  nowMs = Date.now(),
): number {
  const current = Number(config.multiplier);
  const next = Number(config.newMultiplier);
  const raw = config.newMultiplierEffectiveTimestamp;
  const ts = raw === null || raw === undefined || raw === "" ? NaN : Number(raw);
  if (isPositiveFinite(next) && Number.isFinite(ts) && ts > 0) {
    const ms = ts > 1e12 ? ts : ts * 1000;
    if (nowMs >= ms) return next;
  }
  return current;
}

/** On-chain ScaledUiAmount multiplier when the mint has a finite, positive config. */
export function scaledUiMultiplierFromMint(mint: Mint, nowMs = Date.now()): number | undefined {
  const scaled = getScaledUiAmountConfig(mint);
  if (!scaled) return undefined;
  const value = effectiveScaledUiMultiplier(scaled, nowMs);
  return isPositiveFinite(value) ? value : undefined;
}
