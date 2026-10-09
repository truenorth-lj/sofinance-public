/** Half-width of the band around the current B-per-A price, in basis points of that price. */
export const OPEN_RANGE_PRESETS = [
  {
    id: "tight" as const,
    label: "Tight (±0.05%)",
    percentBps: 5,
    default: false,
    narrow: true,
    warning: "Narrow ranges go out of range quickly and stop earning fees.",
  },
  {
    id: "standard" as const,
    label: "Standard (±0.3%)",
    percentBps: 30,
    default: true,
    narrow: false,
    warning: null,
  },
  {
    id: "wide" as const,
    label: "Wide (±1%)",
    percentBps: 100,
    default: false,
    narrow: false,
    warning: null,
  },
] as const;

export type OpenRangePresetId = (typeof OPEN_RANGE_PRESETS)[number]["id"];
export type OpenRangePreset = "tight" | "standard" | "wide" | "custom";

export const DEFAULT_OPEN_RANGE_PRESET: OpenRangePreset = "standard";

export function openRangePresetById(id: string): (typeof OPEN_RANGE_PRESETS)[number] | null {
  return OPEN_RANGE_PRESETS.find((item) => item.id === id) ?? null;
}
