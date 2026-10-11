/**
 * "AI pick" range rule. It is a FIXED rule, not a model: a four-bin band centred on the current price.
 *
 * Definition (the single source of truth for the server resolver and the UI):
 *  - one "tick" in this rule = ONE `tickSpacing` UNIT of the pool, i.e. the distance between two adjacent
 *    valid position boundaries (NOT a raw 0.01% tick, unless the pool's spacing happens to be 1);
 *  - `center` = the valid boundary (multiple of `tickSpacing`) nearest to the current price, measured on the
 *    exact fractional tick of the pool's sqrtPrice (ties go to the lower boundary);
 *  - tickLower = center - 2 * tickSpacing, tickUpper = center + 2 * tickSpacing  (4 spacing units wide).
 *
 * Because `center` is the nearest boundary, the current price is always within half a spacing unit of the
 * centre and therefore strictly inside the range, so the position is two-sided when opened.
 */
import { exactTickFromSqrtPriceX64, floorToSpacing, usableTickBounds } from "./tick-math";

/** Half-width of the AI-pick band, in tick-spacing units. Total width is `2 * AI_PICK_HALF_WIDTH_SPACINGS`. */
export const AI_PICK_HALF_WIDTH_SPACINGS = 2;

export const AI_PICK_PRESET_ID = "ai" as const;
export const AI_PICK_LABEL = "AI pick";
export const AI_PICK_HELP =
  "A fixed rule, not an AI model: a band centred on the current price, 2 tick-spacing steps below and 2 above (4 steps wide). " +
  "Steps are the pool's tick spacing, so the band is very narrow on fine-spaced pools and wider on coarse ones.";

export type AiPickRange = { tickLower: number; tickUpper: number; centerTick: number };

/** Nearest valid boundary to a fractional tick (ties go to the lower one). */
export function nearestBoundary(exactTick: number, tickSpacing: number): number {
  const down = floorToSpacing(exactTick, tickSpacing);
  return exactTick - down > tickSpacing / 2 ? down + tickSpacing : down;
}

/** AI-pick ticks from the pool's fractional current tick. Pure; see the module comment for the definition. */
export function aiPickRangeFromExactTick(exactTick: number, tickSpacing: number): AiPickRange {
  if (!Number.isFinite(exactTick)) throw new Error("Current tick must be finite");
  const { min, max } = usableTickBounds(tickSpacing);
  const width = AI_PICK_HALF_WIDTH_SPACINGS * tickSpacing;
  // Keep the whole band inside the usable tick range (only matters at the extreme ends of the curve).
  const centerTick = Math.min(Math.max(nearestBoundary(exactTick, tickSpacing), min + width), max - width);
  return { tickLower: centerTick - width, tickUpper: centerTick + width, centerTick };
}

export function aiPickRange(sqrtPriceX64: string | bigint, tickSpacing: number): AiPickRange {
  return aiPickRangeFromExactTick(exactTickFromSqrtPriceX64(sqrtPriceX64), tickSpacing);
}
