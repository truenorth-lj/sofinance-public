import { MICRO_HELP, MICRO_LABEL, MICRO_PRESET_ID } from "./range-apr/micro-range";

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

/** Percent-band presets only: this exact list is also what MCP `list_rwa_pairs` publishes as `recommendedRanges`. */
export type OpenRangePresetId = (typeof OPEN_RANGE_PRESETS)[number]["id"];
/** Every preset the web quote API understands. `micro` is tick-based (see `range-apr/micro-range.ts`), web-only. */
export type OpenRangePreset = typeof MICRO_PRESET_ID | OpenRangePresetId | "custom";

export const DEFAULT_OPEN_RANGE_PRESET: OpenRangePreset = "standard";

export function openRangePresetById(id: string): (typeof OPEN_RANGE_PRESETS)[number] | null {
  return OPEN_RANGE_PRESETS.find((item) => item.id === id) ?? null;
}

export type OpenRangeUiPreset = {
  id: Exclude<OpenRangePreset, "custom">;
  /** Full button label, e.g. "Tight (±0.05%)". */
  label: string;
  /** Label without the percentage, used where space is tight (e.g. "AI best" resolved-range text). */
  shortLabel: string;
  /** Tooltip copy for presets whose rule is not obvious from the label. */
  help: string | null;
};

/**
 * The candidate ranges, narrow to wide. This is the canonical order used for the fallback preset row, for
 * tie-breaking and for the remaining buttons next to "AI best" (Custom is appended by the picker).
 */
export const OPEN_RANGE_UI_PRESETS: readonly OpenRangeUiPreset[] = [
  { id: MICRO_PRESET_ID, label: MICRO_LABEL, shortLabel: MICRO_LABEL, help: MICRO_HELP },
  ...OPEN_RANGE_PRESETS.map((preset) => ({
    id: preset.id, label: preset.label, shortLabel: preset.label.replace(/\s*\(.*\)$/, ""), help: null,
  })),
];
