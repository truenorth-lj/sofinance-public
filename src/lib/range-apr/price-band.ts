import "@/lib/engine-host";
/**
 * Client-safe port of the server's price-band to tick conversion (`ticksFromUiPriceBand` in
 * `open-range.ts`): lower = floor(tick(min)) aligned DOWN, upper = floor(tick(max)) aligned UP, at least
 * one spacing apart, clamped to the usable tick range. A parity test keeps the two in step.
 */
import { exactTickFromUiPrice, usableTickBounds, ceilToSpacing, floorToSpacing } from "@sofinance/engine/range-apr/tick-math";

function clampUsable(tick: number, tickSpacing: number): number {
  const { min, max } = usableTickBounds(tickSpacing);
  return Math.min(Math.max(floorToSpacing(tick, tickSpacing), min), max);
}

export function ticksFromPriceBand(
  minPrice: number, maxPrice: number, decimalsA: number, decimalsB: number, tickSpacing: number,
): { tickLower: number; tickUpper: number } | null {
  if (!(minPrice > 0) || !(maxPrice > 0) || minPrice >= maxPrice) return null;
  const tickLower = clampUsable(Math.floor(exactTickFromUiPrice(minPrice, decimalsA, decimalsB)), tickSpacing);
  let tickUpper = clampUsable(ceilToSpacing(Math.floor(exactTickFromUiPrice(maxPrice, decimalsA, decimalsB)), tickSpacing), tickSpacing);
  if (tickLower >= tickUpper) tickUpper = clampUsable(tickLower + tickSpacing, tickSpacing);
  return tickLower < tickUpper ? { tickLower, tickUpper } : null;
}

/** Strict positive decimal as typed in the custom-range inputs (mirrors the server parser). */
export function parsePriceInput(value: string): number | null {
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
