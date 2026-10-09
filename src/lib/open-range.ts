import Decimal from "decimal.js";
import { TickUtil } from "@raydium-io/raydium-sdk-v2";
import { positionSide } from "./quote-math";
import { uiPriceBPerAFromTick } from "./position-performance-math";
import {
  DEFAULT_OPEN_RANGE_PRESET,
  OPEN_RANGE_PRESETS,
  openRangePresetById,
  type OpenRangePreset,
} from "./open-range-presets";

export {
  DEFAULT_OPEN_RANGE_PRESET,
  OPEN_RANGE_PRESETS,
  openRangePresetById,
};
export type { OpenRangePreset, OpenRangePresetId } from "./open-range-presets";

const MIN_TICK = -443636;
const MAX_TICK = 443636;

export type OpenRangeInput =
  | { preset: Exclude<OpenRangePreset, "custom"> }
  | { preset: "custom"; minPrice: string; maxPrice: string };

export type ResolvedOpenRange = {
  preset: OpenRangePreset;
  tickLower: number;
  tickUpper: number;
  tickSpacing: number;
  priceLower: number;
  priceUpper: number;
  currentPrice: number;
  tickCurrent: number;
  rangeSide: "below" | "inside" | "above";
  inRange: boolean;
  requestedMinPrice: number;
  requestedMaxPrice: number;
  narrow: boolean;
  warning: string | null;
};

function parsePositivePrice(value: string, label: string): number {
  if (!/^(0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    throw new Error(`${label} must be a positive decimal (B per 1 A)`);
  }
  const price = Number(value);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error(`${label} must be a positive decimal (B per 1 A)`);
  }
  return price;
}

export function alignTickDown(tick: number, tickSpacing: number): number {
  if (!Number.isInteger(tickSpacing) || tickSpacing <= 0) throw new Error("Invalid pool tick spacing");
  return TickUtil.toTickIndex(tick, tickSpacing);
}

export function alignTickUp(tick: number, tickSpacing: number): number {
  const down = alignTickDown(tick, tickSpacing);
  return down === tick ? tick : down + tickSpacing;
}

export function clampUsableTick(tick: number, tickSpacing: number): number {
  const aligned = alignTickDown(tick, tickSpacing);
  const min = alignTickUp(MIN_TICK, tickSpacing);
  const max = alignTickDown(MAX_TICK, tickSpacing);
  if (aligned < min) return min;
  if (aligned > max) return max;
  return aligned;
}

/** Convert a UI price (B per 1 A) to a raw tick, then align. */
export function tickFromUiPriceBPerA(price: number, decimalsA: number, decimalsB: number): number {
  if (!Number.isFinite(price) || price <= 0) throw new Error("Price must be a positive B-per-A value");
  const sqrt = TickUtil.priceToSqrtPriceX64(new Decimal(price), decimalsA, decimalsB);
  return TickUtil.getTickAtSqrtPrice(sqrt);
}

export function ticksFromUiPriceBand(
  minPrice: number,
  maxPrice: number,
  decimalsA: number,
  decimalsB: number,
  tickSpacing: number,
): { tickLower: number; tickUpper: number } {
  if (!(minPrice > 0) || !(maxPrice > 0) || minPrice >= maxPrice) {
    throw new Error("Price range must be two positive prices with min < max (B per 1 A)");
  }
  const tickLower = clampUsableTick(tickFromUiPriceBPerA(minPrice, decimalsA, decimalsB), tickSpacing);
  let tickUpper = clampUsableTick(alignTickUp(tickFromUiPriceBPerA(maxPrice, decimalsA, decimalsB), tickSpacing), tickSpacing);
  if (tickLower >= tickUpper) tickUpper = clampUsableTick(tickLower + tickSpacing, tickSpacing);
  if (tickLower >= tickUpper) {
    throw new Error("Aligned ticks collapsed; choose a wider price range");
  }
  return { tickLower, tickUpper };
}

export function rangeInputFromFields(
  preset: OpenRangePreset = DEFAULT_OPEN_RANGE_PRESET,
  minPrice?: string,
  maxPrice?: string,
): OpenRangeInput {
  if (preset === "custom") {
    if (!minPrice || !maxPrice) throw new Error("Custom range requires minPrice and maxPrice (B per 1 A)");
    return { preset: "custom", minPrice, maxPrice };
  }
  return { preset };
}

export function resolveOpenRange(input: {
  range: OpenRangeInput;
  currentPrice: number;
  tickCurrent: number;
  sqrtPriceX64: string;
  decimalsA: number;
  decimalsB: number;
  tickSpacing: number;
}): ResolvedOpenRange {
  const { currentPrice, tickCurrent, sqrtPriceX64, decimalsA, decimalsB, tickSpacing } = input;
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error("Pool mid price is not a positive B-per-A value");
  }
  const preset = input.range.preset ?? DEFAULT_OPEN_RANGE_PRESET;
  let requestedMinPrice: number;
  let requestedMaxPrice: number;
  let narrow = false;
  let warning: string | null = null;
  if (input.range.preset === "custom") {
    requestedMinPrice = parsePositivePrice(input.range.minPrice, "Minimum price");
    requestedMaxPrice = parsePositivePrice(input.range.maxPrice, "Maximum price");
  } else {
    const spec = openRangePresetById(preset);
    if (!spec) throw new Error("Unknown range preset");
    const fraction = spec.percentBps / 10_000;
    requestedMinPrice = currentPrice * (1 - fraction);
    requestedMaxPrice = currentPrice * (1 + fraction);
    narrow = spec.narrow;
    warning = spec.warning;
  }
  const { tickLower, tickUpper } = ticksFromUiPriceBand(
    requestedMinPrice, requestedMaxPrice, decimalsA, decimalsB, tickSpacing,
  );
  const priceLower = uiPriceBPerAFromTick(tickLower, decimalsA, decimalsB);
  const priceUpper = uiPriceBPerAFromTick(tickUpper, decimalsA, decimalsB);
  const lowerSqrt = TickUtil.getSqrtPriceAtTick(tickLower);
  const upperSqrt = TickUtil.getSqrtPriceAtTick(tickUpper);
  const rangeSide = positionSide(BigInt(sqrtPriceX64), BigInt(lowerSqrt.toString()), BigInt(upperSqrt.toString()));
  if (narrow && !warning) {
    warning = "Narrow ranges go out of range quickly and stop earning fees.";
  }
  return {
    preset,
    tickLower,
    tickUpper,
    tickSpacing,
    priceLower,
    priceUpper,
    currentPrice,
    tickCurrent,
    rangeSide,
    inRange: rangeSide === "inside",
    requestedMinPrice,
    requestedMaxPrice,
    narrow,
    warning,
  };
}
