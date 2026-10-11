/**
 * Browser-side evaluation of a range selection against the cached per-pool payload (pure).
 * Presets use the ticks the server resolved; a custom band is converted here, so typing a price updates the
 * estimate instantly with no request.
 */
import type { OpenRangePreset } from "../open-range-presets";
import { parsePriceInput, ticksFromPriceBand } from "./price-band";
import { estimateRangeApr, type RangeAprEstimate, type RangeAprInputs } from "./range-apr";
import type { PoolRangeAprPayload } from "./types";

export type RangeSelection = { preset: OpenRangePreset; minPrice: string; maxPrice: string };
export type TickRange = { tickLower: number; tickUpper: number };

export type SelectionEstimate =
  | { status: "incomplete" }
  | { status: "invalid" }
  | { status: "ready"; range: TickRange; estimate: RangeAprEstimate };

export function toRangeAprInputs(payload: PoolRangeAprPayload): RangeAprInputs {
  return {
    tickSpacing: payload.pool.tickSpacing,
    bins: payload.model.bins,
    currentSqrt: payload.model.currentSqrt,
    usdPerRawB: payload.model.usdPerRawB,
    feeRate: payload.pool.feeRate,
    lpFeeFraction: payload.pool.lpFeeFraction,
    avgDailyVolumeUsd: payload.model.avgDailyVolumeUsd,
    capitalUsd: payload.referenceCapitalUsd,
  };
}

/** Ticks of the custom band, or null when either price is missing / not a positive decimal / min >= max. */
export function customTicks(payload: PoolRangeAprPayload, minPrice: string, maxPrice: string): TickRange | null {
  const min = parsePriceInput(minPrice);
  const max = parsePriceInput(maxPrice);
  if (min === null || max === null) return null;
  return ticksFromPriceBand(min, max, payload.pool.decimalsA, payload.pool.decimalsB, payload.pool.tickSpacing);
}

function estimateLocally(payload: PoolRangeAprPayload, selection: RangeSelection): SelectionEstimate {
  if (selection.preset === "custom") {
    if (!selection.minPrice || !selection.maxPrice) return { status: "incomplete" };
    const range = customTicks(payload, selection.minPrice, selection.maxPrice);
    return range
      ? { status: "ready", range, estimate: estimateRangeApr(toRangeAprInputs(payload), range) }
      : { status: "invalid" };
  }
  const preset = payload.presets.find((item) => item.id === selection.preset);
  return preset ? { status: "ready", range: preset, estimate: preset.estimate } : { status: "invalid" };
}

/**
 * Estimate for the current selection. `quotedRange` (the aligned ticks of a live quote for this same
 * selection) wins over locally derived ticks so the headline prices the range that would be signed, as long
 * as it lies inside the analysed window; otherwise the preset / typed band is used.
 */
export function estimateForSelection(
  payload: PoolRangeAprPayload, selection: RangeSelection, quotedRange?: TickRange | null,
): SelectionEstimate {
  const result = estimateUngated(payload, selection, quotedRange);
  // A degraded payload (no price history) never yields a number, whatever the range: custom and quoted
  // ranges are priced in the browser, so they are gated here as well as on the server.
  return payload.sample.degraded && result.status === "ready"
    ? { ...result, estimate: { status: "unavailable", reason: "degraded-data" } }
    : result;
}

function estimateUngated(
  payload: PoolRangeAprPayload, selection: RangeSelection, quotedRange?: TickRange | null,
): SelectionEstimate {
  if (quotedRange) {
    const estimate = estimateRangeApr(toRangeAprInputs(payload), quotedRange);
    if (estimate.status === "ok") return { status: "ready", range: quotedRange, estimate };
  }
  return estimateLocally(payload, selection);
}
