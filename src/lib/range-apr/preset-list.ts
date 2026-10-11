/**
 * Which range is "AI best", and which buttons sit next to it (pure; shared by the Create position modal
 * and the pairs table so both always agree).
 *
 * "AI best" is not a model: it is the candidate with the highest estimated fee APR, ties going to the wider
 * range. It resolves to that candidate's exact ticks, so quote/prepare use the ordinary preset path and what
 * is signed is what was priced.
 */
import type { OpenRangeUiPreset } from "../open-range-presets";
import type { RangeAprEstimate } from "./range-apr";
import type { PoolRangeAprPayload, RangeAprPresetEstimate, RangeAprPresetId } from "./types";

const TIE_RELATIVE_EPSILON = 1e-9;

type OkPreset = RangeAprPresetEstimate & { estimate: Extract<RangeAprEstimate, { status: "ok" }> };

const isOk = (preset: RangeAprPresetEstimate): preset is OkPreset => preset.estimate.status === "ok";
const width = (preset: RangeAprPresetEstimate) => preset.tickUpper - preset.tickLower;
const sameRange = (left: RangeAprPresetEstimate, right: RangeAprPresetEstimate) =>
  left.tickLower === right.tickLower && left.tickUpper === right.tickUpper;

/**
 * Candidate with the highest estimated APR among those with a usable estimate; ties (equal within float
 * noise) prefer the wider range, and between identical ranges the later one in `order` (the wider name).
 * Null when no candidate has an estimate.
 */
export function pickHighestAprPreset(
  candidates: readonly RangeAprPresetEstimate[],
  order: readonly RangeAprPresetId[] = ["micro", "tight", "standard", "wide"],
): RangeAprPresetEstimate | null {
  let best: OkPreset | null = null;
  const rank = (preset: RangeAprPresetEstimate) => order.indexOf(preset.id);
  for (const candidate of candidates.filter(isOk)) {
    if (!best) {
      best = candidate;
      continue;
    }
    const a = candidate.estimate.aprPct;
    const b = best.estimate.aprPct;
    const tied = Math.abs(a - b) <= TIE_RELATIVE_EPSILON * Math.max(1, Math.abs(a), Math.abs(b));
    if (tied
      ? width(candidate) > width(best) || (width(candidate) === width(best) && rank(candidate) > rank(best))
      : a > b) {
      best = candidate;
    }
  }
  return best;
}

export type AiBestButton = {
  /** The preset the button selects (what the quote API receives). */
  id: RangeAprPresetId;
  /** Short name of the range it resolved to, e.g. "Tight". */
  resolvedLabel: string;
  estimate: RangeAprEstimate;
};

export type PresetButton = { id: OpenRangeUiPreset["id"]; label: string; estimate: RangeAprEstimate | null };

export type PresetList = {
  /** Leftmost button; null while loading, on error, or when no candidate has an estimate. */
  aiBest: AiBestButton | null;
  /** The remaining candidates, narrow to wide, without the resolved one. "Custom" is appended by the UI. */
  buttons: PresetButton[];
};

/**
 * Preset row for the modal. Without usable data it is the plain row (Micro, Tight, Standard, Wide) and no
 * "AI best". With data, the resolved candidate is moved into "AI best" and removed from the rest, along with
 * any candidate that covers exactly the same ticks (so no two buttons ever select the same range).
 */
export function buildPresetList(
  uiPresets: readonly OpenRangeUiPreset[], payload: PoolRangeAprPayload | null,
): PresetList {
  const estimateOf = (id: OpenRangeUiPreset["id"]) =>
    payload?.presets.find((preset) => preset.id === id)?.estimate ?? null;
  const best = payload ? pickHighestAprPreset(payload.presets, uiPresets.map((preset) => preset.id) as RangeAprPresetId[]) : null;
  if (!payload || !best) {
    return { aiBest: null, buttons: uiPresets.map((preset) => ({ id: preset.id, label: preset.label, estimate: estimateOf(preset.id) })) };
  }
  const resolved = uiPresets.find((preset) => preset.id === best.id);
  return {
    aiBest: { id: best.id, resolvedLabel: resolved?.shortLabel ?? best.id, estimate: best.estimate },
    buttons: uiPresets
      .filter((preset) => {
        if (preset.id === best.id) return false;
        const candidate = payload.presets.find((item) => item.id === preset.id);
        return !candidate || !sameRange(candidate, best);
      })
      .map((preset) => ({ id: preset.id, label: preset.label, estimate: estimateOf(preset.id) })),
  };
}

/** What the pairs table shows for a pool: the highest-APR candidate and its estimate, or null. */
export function highestRangeSummary(
  uiPresets: readonly OpenRangeUiPreset[], payload: PoolRangeAprPayload,
): { id: RangeAprPresetId; label: string; aprPct: number } | null {
  const { aiBest } = buildPresetList(uiPresets, payload);
  return aiBest && aiBest.estimate.status === "ok"
    ? { id: aiBest.id, label: aiBest.resolvedLabel, aprPct: aiBest.estimate.aprPct }
    : null;
}
