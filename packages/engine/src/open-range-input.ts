import { DEFAULT_OPEN_RANGE_PRESET, type OpenRangePreset } from "./open-range-presets";

export type OpenRangeInput =
  | { preset: Exclude<OpenRangePreset, "custom">; centerOnParity?: boolean }
  | { preset: "custom"; minPrice: string; maxPrice: string };


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
